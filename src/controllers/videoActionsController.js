const mongoose = require('mongoose');
const Video = require('../models/Video');
const Reshare = require('../models/Reshare');
const { toggleSavedVideo, getSavedVideoIds } = require('../services/savedStore');
const { findVideoById: findMemoryVideoById, updateLikeState, addCommentToVideo } = require('../services/videoStore');
const { createNotification } = require('../services/notificationStore');
const { recordVideoWatch: persistVideoWatch } = require('../services/userStore');

const isMongoReady = () => mongoose.connection.readyState === 1 && typeof Video !== 'undefined';

const findVideoById = async (id) => {
  if (!isMongoReady()) {
    const video = await findMemoryVideoById(id);
    if (!video) {
      const error = new Error('Video not found');
      error.status = 404;
      throw error;
    }
    return video;
  }

  const video = await Video.findById(id).lean();
  if (!video) {
    const error = new Error('Video not found');
    error.status = 404;
    throw error;
  }
  return video;
};

const formatVideo = (video) => ({
  id: (video._id || video.id)?.toString?.() || video.id,
  creatorId: video.creatorId,
  title: video.title,
  creatorName: video.creatorName,
  category: video.category,
  description: video.description,
  mediaUrl: video.mediaUrl,
  thumbnailUrl: video.thumbnailUrl,
  views: Number(video.views || 0),
  likes: Number(video.likes || 0),
  comments: Number(video.comments || 0),
  likedBy: Array.isArray(video.likedBy) ? video.likedBy : [],
  commentThread: Array.isArray(video.commentThread) ? video.commentThread.map((comment) => ({
    ...comment,
    commentId: comment.commentId || comment._id?.toString?.(),
    parentCommentId: comment.parentCommentId || null,
  })) : [],
  allowComments: video.allowComments !== false,
  type: video.type,
  createdAt: video.createdAt ? new Date(video.createdAt).toISOString() : undefined,
});

const incrementViews = async (req, res) => {
  try {
    if (!isMongoReady()) {
      const video = await findMemoryVideoById(req.params.id);
      if (!video) return res.status(404).json({ message: 'Video not found.' });
      video.views = Number(video.views || 0) + 1;
      return res.json(formatVideo(video));
    }

    const video = await Video.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true }).lean();
    if (!video) {
      return res.status(404).json({ message: 'Video not found.' });
    }
    return res.json(formatVideo(video));
  } catch (error) {
    console.error('incrementViews error:', error.message);
    return res.status(500).json({ message: 'Unable to update view count.' });
  }
};

const recordVideoWatch = async (req, res) => {
  try {
    const videoId = String(req.params.id || '');
    if (isMongoReady() && !mongoose.Types.ObjectId.isValid(videoId)) {
      return res.status(404).json({ message: 'Video not found.' });
    }

    const video = await findVideoById(videoId);
    const viewerId = String(req.user?.id || '');
    const followingIds = Array.isArray(req.user?.followingIds) ? req.user.followingIds.map(String) : [];
    const creatorId = String(video.creatorId || '');
    const canView = video.status === 'published' && (
      video.visibility === 'public'
      || (video.visibility === 'followers' && followingIds.includes(creatorId))
      || (video.visibility === 'private' && creatorId === viewerId)
    );
    if (!canView) return res.status(404).json({ message: 'Video not found.' });

    const completed = req.body?.completed === true;
    const user = await persistVideoWatch(viewerId, videoId, completed);
    if (!user) return res.status(401).json({ message: 'Authentication required.' });
    return res.json({
      watched: true,
      completed: (user.completedVideoIds || []).map(String).includes(videoId),
      lastViewedVideoId: user.lastViewedVideoId,
    });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ message: 'Video not found.' });
    console.error('recordVideoWatch error:', error.message);
    return res.status(500).json({ message: 'Unable to save watch history.' });
  }
};

const likeVideo = async (req, res) => {
  try {
    if (!isMongoReady()) {
      const video = await findMemoryVideoById(req.params.id);
      if (!video) {
        return res.status(404).json({ message: 'Video not found.' });
      }

      const updated = await updateLikeState(req.params.id, req.user.id);
      if (updated.liked) {
        await createNotification({ recipientId: updated.creatorId, actorId: req.user.id, actorName: req.user.name, actorUsername: req.user.username, actorProfilePictureUrl: req.user.profilePictureUrl, type: 'like', videoId: updated.id, videoTitle: updated.title });
      }
      return res.json({ ...formatVideo(updated), liked: updated.liked, message: updated.liked ? 'Video liked.' : 'Like removed.' });
    }

    const video = await Video.findById(req.params.id).lean();
    if (!video) {
      return res.status(404).json({ message: 'Video not found.' });
    }

    const alreadyLiked = Array.isArray(video.likedBy) && video.likedBy.map(String).includes(String(req.user.id));
    const userId = String(req.user.id);
    const update = alreadyLiked
      ? { $pull: { likedBy: userId }, $inc: { likes: -1 } }
      : { $addToSet: { likedBy: userId }, $inc: { likes: 1 } };
    const updateFilter = alreadyLiked
      ? { _id: req.params.id, likedBy: userId }
      : { _id: req.params.id, likedBy: { $ne: userId } };
    let updated = await Video.findOneAndUpdate(updateFilter, update, { new: true }).lean();
    const changed = Boolean(updated);
    if (!updated) updated = await Video.findById(req.params.id).lean();
    if (!updated) return res.status(404).json({ message: 'Video not found.' });
    updated.likes = Math.max(0, Number(updated.likes || 0));
    const liked = Array.isArray(updated.likedBy) && updated.likedBy.map(String).includes(userId);
    if (changed && liked && !alreadyLiked) {
      await createNotification({ recipientId: updated.creatorId, actorId: req.user.id, actorName: req.user.name, actorUsername: req.user.username, actorProfilePictureUrl: req.user.profilePictureUrl, type: 'like', videoId: updated._id.toString(), videoTitle: updated.title });
    }

    return res.json({ ...formatVideo(updated), liked, message: liked ? 'Video liked.' : 'Like removed.' });
  } catch (error) {
    console.error('likeVideo error:', error.message);
    return res.status(500).json({ message: 'Unable to like the video.' });
  }
};

const commentOnVideo = async (req, res) => {
  const { comment, parentCommentId } = req.body || {};
  const cleanedComment = String(comment || '').trim();
  if (!cleanedComment) {
    return res.status(400).json({ message: 'Comment text is required.' });
  }

  try {
    if (!isMongoReady()) {
      const video = await findMemoryVideoById(req.params.id);
      if (!video) {
        return res.status(404).json({ message: 'Video not found.' });
      }
      if (video.allowComments === false) {
        return res.status(403).json({ message: 'Comments are disabled for this post.' });
      }
      const parent = parentCommentId
        ? video.commentThread?.find((entry) => String(entry.commentId || entry._id) === String(parentCommentId) && !entry.parentCommentId)
        : null;
      if (parentCommentId && !parent) return res.status(404).json({ message: 'The comment you are replying to could not be found.' });

      const entry = {
        commentId: new mongoose.Types.ObjectId().toString(),
        parentCommentId: parent?.commentId || parent?._id?.toString?.() || null,
        userId: req.user.id,
        userName: req.user.name || req.user.username || 'Creator',
        text: cleanedComment,
        createdAt: new Date(),
      };

      const updated = await addCommentToVideo(req.params.id, entry);
      await createNotification({ recipientId: updated.creatorId, actorId: req.user.id, actorName: req.user.name, actorUsername: req.user.username, actorProfilePictureUrl: req.user.profilePictureUrl, type: 'comment', videoId: updated.id, videoTitle: updated.title, comment: cleanedComment });
      return res.status(201).json({
        message: 'Comment created successfully.',
        comment: entry,
        video: formatVideo(updated),
      });
    }

    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ message: 'Video not found.' });
    }
    if (video.allowComments === false) {
      return res.status(403).json({ message: 'Comments are disabled for this post.' });
    }

    const parent = parentCommentId
      ? video.commentThread.find((entry) => String(entry.commentId || entry._id) === String(parentCommentId) && !entry.parentCommentId)
      : null;
    if (parentCommentId && !parent) {
      return res.status(404).json({ message: 'The comment you are replying to could not be found.' });
    }

    const commentEntry = {
      commentId: new mongoose.Types.ObjectId().toString(),
      parentCommentId: parent?.commentId || parent?._id?.toString?.() || null,
      userId: req.user.id,
      userName: req.user.name || req.user.username || 'Creator',
      text: cleanedComment,
      createdAt: new Date(),
    };

    video.commentThread = Array.isArray(video.commentThread) ? video.commentThread : [];
    video.commentThread.push(commentEntry);
    video.comments = Number(video.comments || 0) + 1;
    await video.save();
    await createNotification({ recipientId: video.creatorId, actorId: req.user.id, actorName: req.user.name, actorUsername: req.user.username, actorProfilePictureUrl: req.user.profilePictureUrl, type: 'comment', videoId: video._id.toString(), videoTitle: video.title, comment: cleanedComment });

    return res.status(201).json({
      message: 'Comment created successfully.',
      comment: commentEntry,
      video: formatVideo(video),
    });
  } catch (error) {
    console.error('commentOnVideo error:', error.message);
    return res.status(500).json({ message: 'Unable to comment on the video.' });
  }
};

const reshareVideo = async (req, res) => {
  try {
    const video = await findVideoById(req.params.id);
    const created = await Reshare.findOneAndUpdate(
      { userId: req.user.id, postId: video._id.toString() },
      { userId: req.user.id, postId: video._id.toString() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await createNotification({ recipientId: video.creatorId, actorId: req.user.id, actorName: req.user.name, actorUsername: req.user.username, actorProfilePictureUrl: req.user.profilePictureUrl, type: 'reshare', videoId: video._id.toString(), videoTitle: video.title });

    return res.json({
      message: 'Post reshared.',
      reshared: Boolean(created),
      video: formatVideo(video),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message || 'Unable to reshare video.' });
  }
};

const toggleSaveVideo = async (req, res) => {
  try {
    const video = await findVideoById(req.params.id);
    const result = await toggleSavedVideo(req.user.token, req.params.id);
    if (result.saved) await createNotification({ recipientId: video.creatorId, actorId: req.user.id, actorName: req.user.name, actorUsername: req.user.username, actorProfilePictureUrl: req.user.profilePictureUrl, type: 'save', videoId: video.id || video._id?.toString(), videoTitle: video.title });
    return res.json({ ...result, video: formatVideo(video) });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message || 'Unable to save video.' });
  }
};

const getSavedVideos = async (req, res) => {
  try {
    const ids = await getSavedVideoIds(req.user.token);
    const videos = await Video.find({ _id: { $in: ids }, status: 'published' }).lean();
    return res.json(videos.map(formatVideo));
  } catch (error) {
    console.error('getSavedVideos error:', error.message);
    return res.status(500).json({ message: 'Unable to load saved videos.' });
  }
};

module.exports = {
  incrementViews,
  recordVideoWatch,
  likeVideo,
  commentOnVideo,
  reshareVideo,
  toggleSaveVideo,
  getSavedVideos,
};
