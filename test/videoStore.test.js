process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createVideo,
  updateLikeState,
  findVideoById,
  clearVideoStore,
} = require('../src/services/videoStore');
const videoActionsController = require('../src/controllers/videoActionsController');
const { getVideoById, getVideoFeed } = require('../src/controllers/videoController');
const profileController = require('../src/controllers/profileController');
const { createUser, findById } = require('../src/services/userStore');
const optionalAuth = require('../src/middleware/optionalAuthGuard');
const { loginUser } = require('../src/controllers/authController');

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

test('watch history persists completion and For You prioritizes unseen videos', async () => {
  clearVideoStore();
  const suffix = Date.now().toString();
  const user = {
    id: `watcher-${suffix}`,
    name: 'Watch Tester',
    email: `watcher-${suffix}@example.com`,
    username: `watcher_${suffix}`,
    password: 'private',
    followingIds: [],
    followerIds: [],
  };
  await createUser(user);
  const watchedVideo = await createVideo({ title: 'Already watched', mediaUrl: 'https://example.com/watched.mp4' });
  const unseenVideo = await createVideo({ title: 'Not watched yet', mediaUrl: 'https://example.com/unseen.mp4' });

  const watchedResponse = makeResponse();
  await videoActionsController.recordVideoWatch({
    params: { id: watchedVideo.id },
    body: { completed: false },
    user,
  }, watchedResponse);
  assert.equal(watchedResponse.statusCode, 200);
  assert.equal(watchedResponse.body.watched, true);

  const completedResponse = makeResponse();
  await videoActionsController.recordVideoWatch({
    params: { id: watchedVideo.id },
    body: { completed: true },
    user,
  }, completedResponse);
  assert.equal(completedResponse.body.completed, true);

  const updatedUser = await findById(user.id);
  assert.deepEqual(updatedUser.watchedVideos, [watchedVideo.id]);
  assert.deepEqual(updatedUser.completedVideoIds, [watchedVideo.id]);
  assert.equal(updatedUser.lastViewedVideoId, watchedVideo.id);

  const feedResponse = makeResponse();
  await getVideoFeed({ query: { mode: 'for_you' }, user: updatedUser }, feedResponse);
  assert.deepEqual(feedResponse.body.map((video) => video.id), [unseenVideo.id]);

  await videoActionsController.recordVideoWatch({
    params: { id: unseenVideo.id },
    body: { completed: true },
    user,
  }, makeResponse());
  const exhaustedFeedResponse = makeResponse();
  await getVideoFeed({ query: { mode: 'for_you' }, user: await findById(user.id) }, exhaustedFeedResponse);
  assert.deepEqual(new Set(exhaustedFeedResponse.body.map((video) => video.id)), new Set([watchedVideo.id, unseenVideo.id]));
  assert.equal(exhaustedFeedResponse.body.every((video) => video.watched), true);

  clearVideoStore();
});

test('For You cursor loads further unseen videos without replaying watched posts', async () => {
  clearVideoStore();
  const suffix = Date.now().toString();
  const user = {
    id: `cursor-watcher-${suffix}`,
    name: 'Cursor Tester',
    email: `cursor-${suffix}@example.com`,
    username: `cursor_${suffix}`,
    password: 'private',
    followingIds: [],
    followerIds: [],
  };
  await createUser(user);
  const posts = [];
  for (let index = 0; index < 52; index += 1) {
    posts.push(await createVideo({
      title: `Cursor post ${index}`,
      mediaUrl: `https://example.com/cursor-${index}.mp4`,
      createdAt: new Date(Date.now() - index * 1000),
    }));
  }
  await videoActionsController.recordVideoWatch({
    params: { id: posts[0].id },
    body: { completed: true },
    user,
  }, makeResponse());

  const firstPage = makeResponse();
  await getVideoFeed({ query: { mode: 'for_you' }, user: await findById(user.id) }, firstPage);
  assert.equal(firstPage.body.length, 50);
  assert.equal(firstPage.body.some((video) => video.id === posts[0].id), false);

  const lastLoadedVideo = firstPage.body[firstPage.body.length - 1];
  const secondPage = makeResponse();
  await getVideoFeed({
    query: { mode: 'for_you', before: lastLoadedVideo.createdAt },
    user: await findById(user.id),
  }, secondPage);
  assert.deepEqual(secondPage.body.map((video) => video.id), [posts[51].id]);

  const exhaustedPage = makeResponse();
  await getVideoFeed({
    query: { mode: 'for_you', before: secondPage.body[0].createdAt },
    user: await findById(user.id),
  }, exhaustedPage);
  assert.deepEqual(exhaustedPage.body, []);
  clearVideoStore();
});

test('memory video likes can be added and removed without incorrect counts', async () => {
  clearVideoStore();
  const video = await createVideo({ title: 'Like test', mediaUrl: 'https://example.com/video.mp4' });

  const liked = await updateLikeState(video.id, 'viewer-1');
  assert.equal(liked.liked, true);
  assert.equal(liked.likes, 1);

  const unliked = await updateLikeState(video.id, 'viewer-1');
  assert.equal(unliked.liked, false);
  assert.equal(unliked.likes, 0);

  clearVideoStore();
});

test('comments are enabled by default and can be disabled per video', async () => {
  clearVideoStore();
  const defaultVideo = await createVideo({ title: 'Default comments', mediaUrl: 'https://example.com/default.mp4' });
  const disabledVideo = await createVideo({
    title: 'Disabled comments',
    mediaUrl: 'https://example.com/disabled.mp4',
    allowComments: false,
  });

  assert.equal((await findVideoById(defaultVideo.id)).allowComments, true);
  assert.equal((await findVideoById(disabledVideo.id)).allowComments, false);

  clearVideoStore();
});

test('comment endpoint stores replies against a parent and rejects disabled comments', async () => {
  clearVideoStore();
  const video = await createVideo({ title: 'Thread test', mediaUrl: 'https://example.com/thread.mp4' });
  const rootResponse = makeResponse();

  await videoActionsController.commentOnVideo({
    params: { id: video.id },
    body: { comment: 'Root comment' },
    user: { id: 'viewer-1', name: 'Viewer' },
  }, rootResponse);

  assert.equal(rootResponse.statusCode, 201);
  const rootId = rootResponse.body.comment.commentId;
  const replyResponse = makeResponse();
  await videoActionsController.commentOnVideo({
    params: { id: video.id },
    body: { comment: 'A real reply', parentCommentId: rootId },
    user: { id: 'viewer-2', name: 'Another viewer' },
  }, replyResponse);

  assert.equal(replyResponse.statusCode, 201);
  assert.equal(replyResponse.body.comment.parentCommentId, rootId);
  assert.equal(replyResponse.body.video.comments, 2);

  const disabledVideo = await createVideo({
    title: 'No comments',
    mediaUrl: 'https://example.com/no-comments.mp4',
    allowComments: false,
  });
  const disabledResponse = makeResponse();
  await videoActionsController.commentOnVideo({
    params: { id: disabledVideo.id },
    body: { comment: 'Should not be accepted' },
    user: { id: 'viewer-1', name: 'Viewer' },
  }, disabledResponse);

  assert.equal(disabledResponse.statusCode, 403);
  clearVideoStore();
});

test('like endpoint toggles state and keeps the count in sync', async () => {
  clearVideoStore();
  const video = await createVideo({ title: 'Toggle test', mediaUrl: 'https://example.com/toggle.mp4' });
  const req = { params: { id: video.id }, user: { id: 'viewer-1', name: 'Viewer' } };
  const firstResponse = makeResponse();

  await videoActionsController.likeVideo(req, firstResponse);
  assert.equal(firstResponse.body.liked, true);
  assert.equal(firstResponse.body.likes, 1);

  const secondResponse = makeResponse();
  await videoActionsController.likeVideo(req, secondResponse);
  assert.equal(secondResponse.body.liked, false);
  assert.equal(secondResponse.body.likes, 0);
  clearVideoStore();
});

test('video detail endpoint respects follower and private visibility', async () => {
  clearVideoStore();
  const video = await createVideo({
    title: 'Private test',
    mediaUrl: 'https://example.com/private.mp4',
    creatorId: 'creator-1',
    visibility: 'private',
  });
  const response = makeResponse();

  await getVideoById({ params: { id: video.id }, user: { id: 'viewer-1', followingIds: [] } }, response);
  assert.equal(response.statusCode, 404);

  const ownerResponse = makeResponse();
  await getVideoById({ params: { id: video.id }, user: { id: 'creator-1', followingIds: [] } }, ownerResponse);
  assert.equal(ownerResponse.statusCode, 200);
  assert.equal(ownerResponse.body.id, video.id);
  clearVideoStore();
});

test('anonymous visitors can view public video details without receiving private identity fields', async () => {
  clearVideoStore();
  const video = await createVideo({
    title: 'Public post',
    mediaUrl: 'https://example.com/public.mp4',
    creatorId: 'creator-public',
    visibility: 'public',
    likedBy: ['viewer-private-id'],
  });
  const response = makeResponse();

  await getVideoById({ params: { id: video.id } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.id, video.id);
  assert.equal(response.body.liked, false);
  assert.equal(Object.hasOwn(response.body, 'likedBy'), false);
  clearVideoStore();
});

test('anonymous profile reads expose only published public posts', async () => {
  clearVideoStore();
  const suffix = Date.now().toString();
  const creator = {
    id: `public-creator-${suffix}`,
    name: 'Public Creator',
    email: `private-${suffix}@example.com`,
    username: `public_${suffix}`,
    password: 'not-returned',
    followerIds: [],
    followingIds: [],
  };
  await createUser(creator);
  await createVideo({ creatorId: creator.id, creatorName: creator.name, title: 'Public', mediaUrl: 'https://example.com/public.mp4', visibility: 'public', views: 10, likes: 3 });
  await createVideo({ creatorId: creator.id, creatorName: creator.name, title: 'Followers', mediaUrl: 'https://example.com/followers.mp4', visibility: 'followers' });
  await createVideo({ creatorId: creator.id, creatorName: creator.name, title: 'Private', mediaUrl: 'https://example.com/private.mp4', visibility: 'private' });
  await createVideo({ creatorId: creator.id, creatorName: creator.name, title: 'Queued', mediaUrl: 'https://example.com/queued.mp4', status: 'queued' });
  const profileResponse = makeResponse();

  await profileController.getProfile({ params: { username: creator.username } }, profileResponse);

  assert.equal(profileResponse.statusCode, 200);
  assert.equal(profileResponse.body.stats.posts, 1);
  assert.equal(Object.hasOwn(profileResponse.body.user, 'email'), false);
  assert.equal(Object.hasOwn(profileResponse.body.user, 'password'), false);

  const ownerProfileResponse = makeResponse();
  await profileController.getProfile({ params: { username: creator.username }, user: { id: creator.id, followingIds: [] } }, ownerProfileResponse);
  assert.equal(ownerProfileResponse.body.stats.views, 10);
  assert.equal(ownerProfileResponse.body.stats.likes, 3);

  const postsResponse = makeResponse();
  await profileController.getPosts({ params: { username: creator.username } }, postsResponse);
  assert.deepEqual(postsResponse.body.map((post) => post.title), ['Public']);
  clearVideoStore();
});

test('profile relationship lists paginate and return only public user fields', async () => {
  const suffix = Date.now().toString();
  const firstUser = { id: `relationship-first-${suffix}`, name: 'First User', email: `first-${suffix}@example.com`, username: `first_${suffix}`, password: 'private' };
  const secondUser = { id: `relationship-second-${suffix}`, name: 'Second User', email: `second-${suffix}@example.com`, username: `second_${suffix}`, password: 'private' };
  const creator = {
    id: `relationship-creator-${suffix}`,
    name: 'Relationship Creator',
    email: `creator-${suffix}@example.com`,
    username: `creator_${suffix}`,
    password: 'private',
    followerIds: [firstUser.id, secondUser.id],
    followingIds: [],
  };
  await createUser(creator);
  await createUser(firstUser);
  await createUser(secondUser);

  const response = makeResponse();
  await profileController.getProfileRelationships({
    params: { username: creator.username, type: 'followers' },
    query: { page: '1', limit: '1' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.users.length, 1);
  assert.equal(response.body.users[0].id, firstUser.id);
  assert.equal(response.body.hasMore, true);
  assert.equal(response.body.total, 2);
  assert.equal(Object.hasOwn(response.body.users[0], 'email'), false);
  assert.equal(Object.hasOwn(response.body.users[0], 'password'), false);
});

test('optional authentication permits anonymous reads but rejects an invalid supplied token', () => {
  const anonymousResponse = makeResponse();
  let anonymousNextCalled = false;
  optionalAuth({ headers: {} }, anonymousResponse, () => { anonymousNextCalled = true; });
  assert.equal(anonymousNextCalled, true);

  const invalidResponse = makeResponse();
  let invalidNextCalled = false;
  optionalAuth({ headers: { authorization: 'Bearer invalid-token' } }, invalidResponse, () => { invalidNextCalled = true; });
  assert.equal(invalidNextCalled, false);
  assert.equal(invalidResponse.statusCode, 401);
});

test('configured but unavailable MongoDB does not accept or authenticate in-memory users', async () => {
  const previousMongoUri = process.env.MONGO_URI;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/unavailable';
  process.env.NODE_ENV = 'production';

  try {
    await assert.rejects(
      createUser({ id: 'temporary-user', username: 'temporary_user' }),
      /MongoDB is configured but not connected/
    );

    const response = makeResponse();
    await loginUser({ body: { identity: 'temporary_user', password: 'StrongPass123!' } }, response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /Unable to verify your account right now/);
  } finally {
    if (previousMongoUri === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = previousMongoUri;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
