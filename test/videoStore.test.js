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
const { getVideoById } = require('../src/controllers/videoController');
const profileController = require('../src/controllers/profileController');
const { createUser } = require('../src/services/userStore');
const optionalAuth = require('../src/middleware/optionalAuthGuard');

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
  await createVideo({ creatorId: creator.id, creatorName: creator.name, title: 'Public', mediaUrl: 'https://example.com/public.mp4', visibility: 'public' });
  await createVideo({ creatorId: creator.id, creatorName: creator.name, title: 'Followers', mediaUrl: 'https://example.com/followers.mp4', visibility: 'followers' });
  await createVideo({ creatorId: creator.id, creatorName: creator.name, title: 'Private', mediaUrl: 'https://example.com/private.mp4', visibility: 'private' });
  await createVideo({ creatorId: creator.id, creatorName: creator.name, title: 'Queued', mediaUrl: 'https://example.com/queued.mp4', status: 'queued' });
  const profileResponse = makeResponse();

  await profileController.getProfile({ params: { username: creator.username } }, profileResponse);

  assert.equal(profileResponse.statusCode, 200);
  assert.equal(profileResponse.body.stats.posts, 1);
  assert.equal(Object.hasOwn(profileResponse.body.user, 'email'), false);
  assert.equal(Object.hasOwn(profileResponse.body.user, 'password'), false);

  const postsResponse = makeResponse();
  await profileController.getPosts({ params: { username: creator.username } }, postsResponse);
  assert.deepEqual(postsResponse.body.map((post) => post.title), ['Public']);
  clearVideoStore();
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
