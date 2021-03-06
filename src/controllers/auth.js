var _ = require('lodash');
var validator = require('validator');
var passport = require('passport');
var shared = require('habitrpg-shared');
var async = require('async');
var utils = require('../utils');
var nconf = require('nconf');
var request = require('request');
var User = require('../models/user').model;
var ga = require('./../utils').ga;
var i18n = require('./../i18n');

var isProd = nconf.get('NODE_ENV') === 'production';

var api = module.exports;

var NO_TOKEN_OR_UID = { err: "You must include a token and uid (user id) in your request"};
var NO_USER_FOUND = {err: "No user found."};
var NO_SESSION_FOUND = { err: "You must be logged in." };
var accountSuspended = function(uuid){
  return {
    err: 'Account has been suspended, please contact leslie@habitrpg.com with your UUID ('+uuid+') for assistance.',
    code: 'ACCOUNT_SUSPENDED'
  };
}

var emailUser = function(name, email, emailType){
  request({
    url: nconf.get('EMAIL_SERVER_URL') + '/job',
    method: 'POST',
    auth: {
      user: nconf.get('EMAIL_SERVER_AUTH_USER'),
      pass: nconf.get('EMAIL_SERVER_AUTH_PASSWORD')
    },
    json: {
      type: 'email', 
      data: {
        emailType: emailType,
        to: {
          name: name,
          email: email
        }
      },
      options: {
        attemps: 5,
        backoff: {delay: 10*60*1000, type: 'fixed'}
      }
    }
  });
}

api.auth = function(req, res, next) {
  var uid = req.headers['x-api-user'];
  var token = req.headers['x-api-key'];
  if (!(uid && token)) return res.json(401, NO_TOKEN_OR_UID);
  User.findOne({_id: uid,apiToken: token}, function(err, user) {
    if (err) return next(err);
    if (_.isEmpty(user)) return res.json(401, NO_USER_FOUND);
    if (user.auth.blocked) return res.json(401, accountSuspended(user._id));

    res.locals.wasModified = req.query._v ? +user._v !== +req.query._v : true;
    res.locals.user = user;
    req.session.userId = user._id;
    return next();
  });
};

api.authWithSession = function(req, res, next) { //[todo] there is probably a more elegant way of doing this...
  if (!(req.session && req.session.userId))
    return res.json(401, NO_SESSION_FOUND);
  User.findOne({_id: req.session.userId}, function(err, user) {
    if (err) return next(err);
    if (_.isEmpty(user)) return res.json(401, NO_USER_FOUND);
    res.locals.user = user;
    next();
  });
};

api.authWithUrl = function(req, res, next) {
  User.findOne({_id:req.query._id, apiToken:req.query.apiToken}, function(err,user){
    if (err) return next(err);
    if (_.isEmpty(user)) return res.json(401, NO_USER_FOUND);
    res.locals.user = user;
    next();
  })
}

api.registerUser = function(req, res, next) {
  var confirmPassword = req.body.confirmPassword,
    email = req.body.email,
    password = req.body.password,
    username = req.body.username;
  if (!(username && password && email)) return res.json(401, {err: ":username, :email, :password, :confirmPassword required"});
  if (password !== confirmPassword) return res.json(401, {err: ":password and :confirmPassword don't match"});
  if (!validator.isEmail(email)) return res.json(401, {err: ":email invalid"});
  async.waterfall([
    function(cb) {
      User.findOne({'auth.local.email': email}, cb);
    },
    function(found, cb) {
      if (found) return cb("Email already taken");
      User.findOne({'auth.local.username': username}, cb);
    }, function(found, cb) {
      var newUser, salt, user;
      if (found) return cb("Username already taken");
      salt = utils.makeSalt();
      newUser = {
        auth: {
          local: {
            username: username,
            email: email,
            salt: salt,
            hashed_password: utils.encryptPassword(password, salt)
          },
          timestamps: {created: +new Date(), loggedIn: +new Date()}
        }
      };
      newUser.preferences = newUser.preferences || {};
      newUser.preferences.language = req.language; // User language detected from browser, not saved
      user = new User(newUser);

      // temporary for conventions
      if (req.subdomains[0] == 'con') {
        _.each(user.dailys, function(h){
          h.repeat = {m:false,t:false,w:false,th:false,f:false,s:false,su:false};
        })
        user.extra = {signupEvent: 'wondercon'};
      }

      user.save(cb);
      if(isProd) emailUser(username, email, 'welcome');
      ga.event('register', 'Local').send()
    }
  ], function(err, saved) {
    if (err) return res.json(401, {err: err});
    res.json(200, saved);
    email = password = username = null;
  });
};

/*
 Register new user with uname / password
 */


api.loginLocal = function(req, res, next) {
  var username = req.body.username;
  var password = req.body.password;
  if (!(username && password)) return res.json(401, {err:'Missing :username or :password in request body, please provide both'});
  var login = validator.isEmail(username) ? {'auth.local.email':username} : {'auth.local.username':username};
  User.findOne(login, {auth:1}, function(err, user){
    if (err) return next(err);
    if (!user) return res.json(401, {err:"Username or password incorrect. Click 'Forgot Password' for help with either. (Note: usernames are case-sensitive)"});
    if (user.auth.blocked) return res.json(401, accountSuspended(user._id));
    // We needed the whole user object first so we can get his salt to encrypt password comparison
    User.findOne(
      {$and: [login, {'auth.local.hashed_password': utils.encryptPassword(password, user.auth.local.salt)}]}
    , {_id:1, apiToken:1}
    , function(err, user){
      if (err) return next(err);
      if (!user) return res.json(401,{err:"Username or password incorrect. Click 'Forgot Password' for help with either. (Note: usernames are case-sensitive)"});
      res.json({id: user._id,token: user.apiToken});
      password = null;
    });
  });
};

/*
 POST /user/auth/facebook
 */


api.loginFacebook = function(req, res, next) {
  var facebook_id = req.body.facebook_id;
  if (!facebook_id) return res.json(401, {err: 'No facebook id provided'});
  User.findOne({'auth.facebook.id': facebook_id}, function(err, user) {
    if (err) {
      return res.json(401, {err: err});
    } else if (user) {
      if (user.auth.blocked) return res.json(401, accountSuspended(user._id));
      return res.json(200, {id: user.id,token: user.apiToken});
    } else {
      /* FIXME: create a new user instead*/
      return res.json(403, {err: "Please register with Facebook on https://habitrpg.com, then come back here and log in."});
    }
  });
};

api.resetPassword = function(req, res, next){
  var email = req.body.email,
    salt = utils.makeSalt(),
    newPassword =  utils.makeSalt(), // use a salt as the new password too (they'll change it later)
    hashed_password = utils.encryptPassword(newPassword, salt);

  // escape email for regex, then search case-insensitive. See http://stackoverflow.com/a/3561711/362790
  var emailRegExp = new RegExp('^' + email.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '$', 'i');
  User.findOne({'auth.local.email':emailRegExp}, function(err, user){
    if (err) return next(err);
    if (!user) return res.send(500, {err:"Couldn't find a user registered for email " + email});
    user.auth.local.salt = salt;
    user.auth.local.hashed_password = hashed_password;
    utils.sendEmail({
      from: "HabitRPG <admin@habitrpg.com>",
      to: email,
      subject: "Password Reset for HabitRPG",
      text: "Password for " + user.auth.local.username + " has been reset to " + newPassword + ". Log in at " + nconf.get('BASE_URL'),
      html: "Password for <strong>" + user.auth.local.username + "</strong> has been reset to <strong>" + newPassword + "</strong>. Log in at " + nconf.get('BASE_URL')
    });
    user.save();
    res.send('New password sent to '+ email);
    email = salt = newPassword = hashed_password = null;
  });
};

api.changeUsername = function(req, res, next) {
  var user = res.locals.user,
    password = req.body.password,
    newUsername = req.body.newUsername;

  User.findOne({'auth.local.username': newUsername}, function(err, result) {
    if (err) next(err);
    if(result) return res.json(401, {err: "Username already taken"});

    var salt = user.auth.local.salt;
    var hashed_password = utils.encryptPassword(password, salt);

    if (hashed_password !== user.auth.local.hashed_password)
      return res.json(401, {err:"Incorrect password"});

    user.auth.local.username = newUsername;
    user.save(function(err, saved){
      if (err) next(err);
      res.send(200);
      user = password = newUsername = null;
    })
  });
}

api.changePassword = function(req, res, next) {
  var user = res.locals.user,
    oldPassword = req.body.oldPassword,
    newPassword = req.body.newPassword,
    confirmNewPassword = req.body.confirmNewPassword;

  if (newPassword != confirmNewPassword)
    return res.json(401, {err: "Password & Confirm don't match"});

  var salt = user.auth.local.salt,
    hashed_old_password = utils.encryptPassword(oldPassword, salt),
    hashed_new_password = utils.encryptPassword(newPassword, salt);

  if (hashed_old_password !== user.auth.local.hashed_password)
    return res.json(401, {err:"Old password doesn't match"});

  user.auth.local.hashed_password = hashed_new_password;
  user.save(function(err, saved){
    if (err) next(err);
    res.send(200);
  })
}

/*
 Registers a new user. Only accepting username/password registrations, no Facebook
 */

api.setupPassport = function(router) {

  router.get('/logout', i18n.getUserLanguage, function(req, res) {
    req.logout();
    delete req.session.userId;
    res.redirect('/');
  })

  // GET /auth/facebook
  //   Use passport.authenticate() as route middleware to authenticate the
  //   request.  The first step in Facebook authentication will involve
  //   redirecting the user to facebook.com.  After authorization, Facebook will
  //   redirect the user back to this application at /auth/facebook/callback
  router.get('/auth/facebook',
    passport.authenticate('facebook', {scope: 'email'}),
    i18n.getUserLanguage,
    function(req, res){
      // The request will be redirected to Facebook for authentication, so this
      // function will not be called.
    });

  // GET /auth/facebook/callback
  //   Use passport.authenticate() as route middleware to authenticate the
  //   request.  If authentication fails, the user will be redirected back to the
  //   login page.  Otherwise, the primary route function function will be called,
  //   which, in this example, will redirect the user to the home page.
  router.get('/auth/facebook/callback',
    passport.authenticate('facebook', { failureRedirect: '/login' }),
    i18n.getUserLanguage,
    function(req, res) {
      //res.redirect('/');

      async.waterfall([
        function(cb){
          User.findOne({'auth.facebook.id':req.user.id}, cb)
        },
        function(user, cb){
          if (user) return cb(null, user);

          user = new User({
            preferences: {
              language: req.language // User language detected from browser, not saved
            },
            auth: {
              facebook: req.user,
              timestamps: {created: +new Date(), loggedIn: +new Date()}
            }
          });
          user.save(cb);
          if(isProd && req.user.emails && req.user.emails[0] && req.user.emails[0].value){
            emailUser((req.user.displayName || req.user.username), req.user.emails[0].value, 'welcome');
          }
          ga.event('register', 'Facebook').send()
        }
      ], function(err, saved){
        if (err) return res.redirect('/static/front?err=' + err);
        req.session.userId = saved._id;
        res.redirect('/static/front?_id='+saved._id+'&apiToken='+saved.apiToken);
      })
    });

  // Simple route middleware to ensure user is authenticated.
  //   Use this route middleware on any resource that needs to be protected.  If
  //   the request is authenticated (typically via a persistent login session),
  //   the request will proceed.  Otherwise, the user will be redirected to the
  //   login page.
//  function ensureAuthenticated(req, res, next) {
//    if (req.isAuthenticated()) { return next(); }
//    res.redirect('/login')
//  }
};
