const mongoose = require('mongoose');
const User = require('../models/User');

const memoryUsers = [];
const passwordResets = new Map();

const isMongoReady = () => mongoose.connection.readyState === 1 && typeof User !== 'undefined';
const isMongoRequired = () => Boolean(process.env.MONGO_URI) && process.env.NODE_ENV !== 'test';
const shouldUseMemoryStore = () => {
  if (isMongoRequired() && !isMongoReady()) {
    throw new Error('MongoDB is configured but not connected; persistent user data is unavailable.');
  }
  return !isMongoReady();
};

const normalizeSearchText = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/^@+/, '')
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const findByEmail = async (email) => {
  if (shouldUseMemoryStore()) {
    return memoryUsers.find((user) => user.email === email) || null;
  }

  try {
    return await User.findOne({ email }).lean();
  } catch (error) {
    if (isMongoRequired()) throw error;
    console.warn('MongoDB unavailable for findByEmail, falling back to memory store:', error.message);
    return memoryUsers.find((user) => user.email === email) || null;
  }
};

const findUsersByEmail = async (email) => {
  if (shouldUseMemoryStore()) return memoryUsers.filter((user) => user.email === email);
  try {
    return await User.find({ email }).lean();
  } catch (error) {
    if (isMongoRequired()) throw error;
    console.warn('MongoDB unavailable for findUsersByEmail, falling back to memory store:', error.message);
    return memoryUsers.filter((user) => user.email === email);
  }
};

const countUsersByEmail = async (email) => (await findUsersByEmail(email)).length;

const findById = async (id) => {
  if (!id) return null;
  if (shouldUseMemoryStore()) return memoryUsers.find((user) => user.id === id) || null;
  try {
    return await User.findOne({ id }).lean();
  } catch (error) {
    if (isMongoRequired()) throw error;
    console.warn('MongoDB unavailable for findById, falling back to memory store:', error.message);
    return memoryUsers.find((user) => user.id === id) || null;
  }
};

const findManyByIds = async (ids) => {
  const requestedIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!requestedIds.length) return [];
  if (shouldUseMemoryStore()) {
    const usersById = new Map(memoryUsers.map((user) => [String(user.id), user]));
    return requestedIds.map((id) => usersById.get(id)).filter(Boolean);
  }
  try {
    const users = await User.find({ id: { $in: requestedIds } }).lean();
    const usersById = new Map(users.map((user) => [String(user.id), user]));
    return requestedIds.map((id) => usersById.get(id)).filter(Boolean);
  } catch (error) {
    if (isMongoRequired()) throw error;
    console.warn('MongoDB unavailable for findManyByIds, falling back to memory store:', error.message);
    const usersById = new Map(memoryUsers.map((user) => [String(user.id), user]));
    return requestedIds.map((id) => usersById.get(id)).filter(Boolean);
  }
};

const findByUsername = async (username) => {
  if (!username) return null;
  const normalized = username.toLowerCase();
  if (shouldUseMemoryStore()) return memoryUsers.find((user) => user.username === normalized) || null;
  try {
    return await User.findOne({ username: normalized }).lean();
  } catch (error) {
    if (isMongoRequired()) throw error;
    console.warn('MongoDB unavailable for findByUsername, falling back to memory store:', error.message);
    return memoryUsers.find((user) => user.username === normalized) || null;
  }
};

const searchUsers = async (query, limit = 12) => {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const terms = normalized.split(' ').filter(Boolean);
  const safeTerms = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regexes = safeTerms.map((term) => new RegExp(term, 'i'));
  const matchesUser = (user) => {
    const username = normalizeSearchText(user.username);
    const name = normalizeSearchText(user.name);
    const email = normalizeSearchText(user.email);
    const searchable = `${username} ${name} ${email}`;
    return regexes.every((regex) => regex.test(searchable));
  };
  const scoreUser = (user) => {
    const username = normalizeSearchText(user.username);
    const name = normalizeSearchText(user.name);
    if (username === normalized) return 0;
    if (username.startsWith(normalized)) return 1;
    if (name === normalized) return 2;
    if (name.startsWith(normalized)) return 3;
    return 4;
  };

  if (shouldUseMemoryStore()) {
    return memoryUsers
      .filter(matchesUser)
      .sort((first, second) => scoreUser(first) - scoreUser(second))
      .slice(0, limit);
  }

  try {
    return await User.find({
      $and: safeTerms.map((term) => ({
        $or: [
          { username: { $regex: term, $options: 'i' } },
          { name: { $regex: term, $options: 'i' } },
          { email: { $regex: term, $options: 'i' } },
        ],
      })),
    }).limit(Math.max(limit, 50)).lean().then((users) => users
      .filter(matchesUser)
      .sort((first, second) => scoreUser(first) - scoreUser(second))
      .slice(0, limit));
  } catch (error) {
    if (isMongoRequired()) throw error;
    console.warn('MongoDB unavailable for searchUsers, falling back to memory store:', error.message);
    return memoryUsers
      .filter(matchesUser)
      .sort((first, second) => scoreUser(first) - scoreUser(second))
      .slice(0, limit);
  }
};

const updateById = async (id, updates) => {
  if (shouldUseMemoryStore()) {
    const user = memoryUsers.find((item) => item.id === id);
    if (user) Object.assign(user, updates);
    return user || null;
  }
  try {
    return await User.findOneAndUpdate({ id }, { $set: updates }, { new: true, lean: true });
  } catch (error) {
    if (isMongoRequired()) throw error;
    console.warn('MongoDB unavailable for updateById, falling back to memory store:', error.message);
    const user = memoryUsers.find((item) => item.id === id);
    if (user) Object.assign(user, updates);
    return user || null;
  }
};

const updateRelationships = async (id, update) => {
  if (shouldUseMemoryStore()) {
    const user = memoryUsers.find((item) => item.id === id);
    if (user) {
      user.followerIds = update.followerIds || user.followerIds;
      user.followingIds = update.followingIds || user.followingIds;
    }
    return user || null;
  }
  try {
    return await User.findOneAndUpdate({ id }, { $set: update }, { new: true, lean: true });
  } catch (error) {
    if (isMongoRequired()) throw error;
    console.warn('MongoDB unavailable for updateRelationships, falling back to memory store:', error.message);
    const user = memoryUsers.find((item) => item.id === id);
    if (user) Object.assign(user, update);
    return user || null;
  }
};

const usernameExists = async (username, exceptId) => {
  const normalized = username.toLowerCase();
  if (shouldUseMemoryStore()) return memoryUsers.some((user) => user.username === normalized && user.id !== exceptId);
  try {
    return Boolean(await User.findOne({ username: normalized, ...(exceptId ? { id: { $ne: exceptId } } : {}) }).lean());
  } catch (error) {
    if (isMongoRequired()) throw error;
    return memoryUsers.some((user) => user.username === normalized && user.id !== exceptId);
  }
};

const createUser = async (user) => {
  if (shouldUseMemoryStore()) {
    memoryUsers.push(user);
    return user;
  }

  try {
    const created = await User.create(user);
    return created.toObject();
  } catch (error) {
    if (error.code === 11000) throw error;
    if (process.env.MONGO_URI) throw error;
    console.warn('MongoDB unavailable for createUser, falling back to memory store:', error.message);
    memoryUsers.push(user);
    return user;
  }
};

const storePasswordReset = async (email, payload) => {
  passwordResets.set(email, payload);
  return payload;
};

const getPasswordReset = async (email) => passwordResets.get(email) || null;

const deletePasswordReset = async (email) => {
  passwordResets.delete(email);
};

module.exports = {
  findByEmail,
  findUsersByEmail,
  countUsersByEmail,
  findById,
  findManyByIds,
  findByUsername,
  searchUsers,
  updateById,
  updateRelationships,
  usernameExists,
  createUser,
  storePasswordReset,
  getPasswordReset,
  deletePasswordReset,
};
