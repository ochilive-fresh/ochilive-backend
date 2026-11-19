const authenticate = require('./authGuard');

const optionalAuth = (req, res, next) => {
  if (!req.headers.authorization) return next();
  return authenticate(req, res, next);
};

module.exports = optionalAuth;
