process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const Conversation = require('../src/models/Conversation');
const Message = require('../src/models/Message');
const { sendMessage } = require('../src/controllers/messageController');

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

test('sendMessage looks up and persists the requested receiver', async () => {
  const originalFindOne = User.findOne;
  const originalConversationFindOne = Conversation.findOne;
  const originalConversationSave = Conversation.prototype.save;
  const originalMessageSave = Message.prototype.save;
  const sender = { id: 'sender-id', name: 'Sender', username: 'sender', accountType: 'creator', followingIds: [] };
  const receiver = { id: 'receiver-id', name: 'Receiver', username: 'receiver', accountType: 'creator', followingIds: [] };
  let savedMessage;

  User.findOne = async ({ id }) => id === sender.id ? sender : id === receiver.id ? receiver : null;
  Conversation.findOne = async () => null;
  Conversation.prototype.save = async function saveConversation() { return this; };
  Message.prototype.save = async function saveMessage() {
    savedMessage = this;
    this._id = 'message-id';
    return this;
  };

  try {
    const response = makeResponse();
    await sendMessage({
      body: { receiverId: receiver.id, text: 'Hello there.' },
      user: { id: sender.id },
    }, response);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.data.inbox, 'requests');
    assert.equal(savedMessage.receiverId, receiver.id);
  } finally {
    User.findOne = originalFindOne;
    Conversation.findOne = originalConversationFindOne;
    Conversation.prototype.save = originalConversationSave;
    Message.prototype.save = originalMessageSave;
  }
});
