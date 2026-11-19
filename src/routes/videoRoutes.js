const express = require('express');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const authenticate = require('../middleware/authGuard');
const optionalAuth = require('../middleware/optionalAuthGuard');
const requireComedian = require('../middleware/comedianGuard');
const LiveRoom = require('../models/LiveRoom');
const { createRoom, startRoom, endRoom } = require('../controllers/liveController');
const { getVideoFeed, getVideoById, uploadVideoPost } = require('../controllers/videoController');
const { getVideoThumbnailUrl, getOptimizedMediaUrl, uploadBuffer } = require('../services/cloudinaryService');
const {
  incrementViews,
  recordVideoWatch,
  deleteVideoPost,
  likeVideo,
  commentOnVideo,
  toggleSaveVideo,
  getSavedVideos,
  reshareVideo,
} = require('../controllers/videoActionsController');

const router = express.Router();
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (/^(video|image)\//.test(file.mimetype)) return callback(null, true);
    return callback(new Error('Only image and video files are supported.'));
  },
});

const ensureLiveKitConfig = () => {
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    throw new Error('LiveKit environment variables are missing. Configure LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in backend/.env.');
  }
};

const createLiveKitToken = async (user, roomId, role = 'viewer') => {
  ensureLiveKitConfig();

  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: String(user.id),
    name: user.name || user.username || 'Ochi Live viewer',
  });

  token.addGrant({
    room: String(roomId),
    roomJoin: true,
    canPublish: role === 'host',
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: role === 'host',
  });

  return { token: await token.toJwt(), livekitUrl: process.env.LIVEKIT_URL };
};

const createRoomService = () => {
  ensureLiveKitConfig();
  const serviceUrl = process.env.LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  return new RoomServiceClient(serviceUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
};

const getRoomForToken = async (roomId, hostId = null) => {
  const query = { id: roomId };
  if (hostId) query.hostId = hostId;

  const room = await LiveRoom.findOne(query).lean();
  if (!room) {
    throw new Error('Live room not found.');
  }
  return room;
};

const issueHostToken = async (req, res) => {
  try {
    const room = await getRoomForToken(req.params.id, req.user.id);
    const payload = await createLiveKitToken(req.user, room.id, 'host');
    return res.json({
      roomId: room.id,
      roomName: room.id,
      ...payload,
      message: 'Host token generated.',
    });
  } catch (error) {
    const message = error?.message || 'Unable to generate the host token.';
    return res.status(error?.message === 'Live room not found.' ? 404 : 500).json({ message });
  }
};

const issueViewerToken = async (req, res) => {
  try {
    const room = await getRoomForToken(req.params.id);
    if (room.status !== 'live') {
      return res.status(409).json({ message: 'This live room is not active yet.' });
    }
    if ((room.blockedParticipantIds || []).map(String).includes(String(req.user.id))) {
      return res.status(403).json({ message: 'You have been removed from this live room.' });
    }
    const payload = await createLiveKitToken(req.user, room.id, 'viewer');
    return res.json({
      roomId: room.id,
      roomName: room.id,
      ...payload,
      message: 'Viewer token generated.',
    });
  } catch (error) {
    const message = error?.message || 'Unable to generate the viewer token.';
    return res.status(error?.message === 'Live room not found.' ? 404 : 500).json({ message });
  }
};

const removeLiveParticipant = async (req, res) => {
  const identity = String(req.body?.identity || '').trim();
  if (!identity) return res.status(400).json({ message: 'Choose a participant to remove.' });
  if (identity === String(req.user.id)) return res.status(400).json({ message: 'You cannot remove yourself from your room.' });

  try {
    const room = await LiveRoom.findOne({ id: req.params.id, hostId: req.user.id, status: 'live' });
    if (!room) return res.status(404).json({ message: 'Live room not found or no longer active.' });
    const livekit = createRoomService();
    const participants = await livekit.listParticipants(room.id);
    if (!participants.some((participant) => participant.identity === identity)) {
      return res.status(404).json({ message: 'Participant is no longer in this room.' });
    }

    const alreadyBlocked = (room.blockedParticipantIds || []).map(String).includes(identity);
    if (!alreadyBlocked) {
      await LiveRoom.updateOne({ _id: room._id }, { $addToSet: { blockedParticipantIds: identity } });
    }

    try {
      await livekit.removeParticipant(room.id, identity, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) });
    } catch (error) {
      if (!alreadyBlocked) {
        await LiveRoom.updateOne({ _id: room._id }, { $pull: { blockedParticipantIds: identity } });
      }
      throw error;
    }

    return res.json({ ok: true, message: 'Participant removed from the room.' });
  } catch (error) {
    console.error('Unable to remove live room participant:', error.message);
    const status = error?.message?.includes('environment variables are missing') ? 503 : 502;
    return res.status(status).json({ message: error?.message || 'Unable to remove this participant.' });
  }
};

router.get('/', optionalAuth, getVideoFeed);
router.post('/upload', authenticate, uploadVideoPost);
// Stream single media uploads to Cloudinary at /videos/upload-file.
const handleMediaUpload = (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Media files must be 100 MB or smaller.' });
    }
    return res.status(400).json({ message: error.message || 'Unsupported media upload.' });
  });
};

router.post('/upload-file', authenticate, handleMediaUpload, async (req, res) => {
  try {
    // build public path
    if (!req.file) return res.status(400).json({ message: 'No file provided.' });
    const isVideo = req.file.mimetype.startsWith('video/');
    const resourceType = isVideo ? 'video' : 'image';
    const result = await uploadBuffer(req.file.buffer, {
      resourceType,
      folder: `ochi-live/${resourceType}s/${req.user.id}`,
    });
    const thumbnailUrl = isVideo ? getVideoThumbnailUrl(result.public_id) : result.secure_url;

    return res.status(201).json({
      message: 'File uploaded.',
      url: result.secure_url,
      mediaUrl: getOptimizedMediaUrl(result.public_id, resourceType),
      thumbnailUrl,
      publicId: result.public_id,
      resourceType,
      duration: result.duration || null,
      width: result.width || null,
      height: result.height || null,
    });
  } catch (error) {
    console.error('Cloudinary media upload failed:', error.message);
    const status = error.message?.includes('not configured') ? 503 : 500;
    return res.status(status).json({ message: error.message || 'Unable to upload media.' });
  }
});
router.post('/live/rooms', authenticate, requireComedian, createRoom);
router.post('/live/rooms/:id/start', authenticate, requireComedian, startRoom);
router.post('/live/rooms/:id/end', authenticate, requireComedian, endRoom);
router.post('/live/rooms/:id/host-token', authenticate, requireComedian, issueHostToken);
router.post('/live/rooms/:id/viewer-token', authenticate, issueViewerToken);
router.post('/live/rooms/:id/participants/remove', authenticate, removeLiveParticipant);
router.post('/:id/view', incrementViews);
router.post('/:id/watch', authenticate, recordVideoWatch);
router.delete('/:id', authenticate, deleteVideoPost);
router.post('/:id/like', authenticate, likeVideo);
router.post('/:id/reshare', authenticate, reshareVideo);
router.post('/:id/comments', authenticate, commentOnVideo);
router.post('/:id/save', authenticate, toggleSaveVideo);
router.get('/saved', authenticate, getSavedVideos);
router.get('/:id', optionalAuth, getVideoById);

module.exports = router;
