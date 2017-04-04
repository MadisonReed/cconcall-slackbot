/**
 * CCOnCall #slack bot that works for color crew
 **
 */

var config = require('config');
var pjson = require('./package.json');
var async = require('async');
var debug = require('debug')('cconcall_bot');
var _ = require('underscore');
var fs = require('fs');


var SlackBot = require('slackbots');

const NodeCache = require("node-cache");
var cache = new NodeCache();
var cacheInterval = config.get("slack.cache_interval_seconds");

// create a bot
var bot = new SlackBot({
  token: config.get('slack.slack_token'), // Add a bot https://my.slack.com/services/new/bot and put the token
  name: config.get('slack.bot_name')
});
var iconEmoji = config.get('slack.emoji');
var testUser = config.get('slack.test_user');
var oncallSlackers = config.get('slack.oncall_slackers');

// getUser constants
const FIND_BY_ID = 0;
const FIND_BY_EMAIL = 1;
const FIND_BY_NAME = 2;

// commands
const HELP_REGEX = new RegExp('^[hH]elp$');
const WHO_REGEX = new RegExp('^[wW]ho$');
const VERSION_REGEX = new RegExp('^[vV]ersion$');
const ADD_USER_REGEX = new RegExp('^[aA]dd (\\\w+)$');
const ADD_USERID_REGEX = new RegExp('^[aA]dd <@(\\\w+)>$');
const REMOVE_USER_REGEX = new RegExp('^[rR]emove (\\\w+)$');
const REMOVE_USERID_REGEX = new RegExp('^[rR]emove <@(\\\w+)>$');

/**
 * Send a message to the oncall people.
 *
 * @param message
 */
var messageOnCalls = function (message) {
  getOnCallSlackers(function (slackers) {
    _.each(slackers, function (slacker) {
      debug('POST MESSAGE TO: ' + slacker);
      bot.postMessageToUser(testUser || slacker, message, {icon_emoji: iconEmoji});
    })
  });
};

/**
 * Mention oncall people in a channel.
 *
 * @param channel
 * @param message
 */
var mentionOnCalls = function (channel, message) {
  var usersToMention = '';
  getOnCallSlackers(function (slackers) {
    _.each(slackers, function (slacker) {
      usersToMention += '<@' + (testUser || slacker) + '> ';
    });
    bot.postMessageToChannel(channel, usersToMention.trim() + ', ' + message, {icon_emoji: iconEmoji});
  });
};


/**
 * Post message with reference to on call peeps
 *
 * @param obj
 * @param preMessage
 * @param postMessage
 * @param direct
 */
var postMessage = function (obj, preMessage, postMessage, direct) {
  var usersToMention = '';
  getOnCallSlackers(function (slackers) {
    _.each(slackers, function (slacker) {
      usersToMention += '<@' + (testUser || slacker) + '> ';
    });
    usersToMention = usersToMention.trim().length > 0 ? usersToMention.trim() : ':ghost:';
    var message = ' ' + usersToMention.trim() + ' ' + postMessage;
    if (direct) {
      bot.postMessageToUser(obj, message, {icon_emoji: iconEmoji});
    } else {
      bot.postMessage(obj, message, {icon_emoji: iconEmoji});
    }
  });
};

/**
 * Get the channels and cache 'em
 *
 * @param callback
 */
var cacheChannels = function (callback) {
  bot.getChannels().then(function (data) {
    debug("Caching channels");
    async.each(data, function (channel, cb) {
      debug("channel: " + JSON.stringify(channel));
      cb();
    }, function (err) {
      if (err) {
        debug(err);
      } else {
        cache.set('channels', data, cacheInterval, callback);
      }
    });
  });
};

/**
 * Get the users and cache 'em.
 *
 * @param callback
 */
var cacheUsers = function (callback) {
  bot.getUsers().then(function (data) {
    async.each(data.members, function (user, each_cb) {
      debug("Caching user name/id: " + user.name + " - " + user.id);

      async.parallel([
        function (cb) {
          cache.set(user.name, user, cacheInterval, cb);
        },
        function (cb) {
          cache.set('ID:' + user.id, user, cacheInterval, cb);
        }
      ], each_cb);
    }, function (err) {
      if (err) {
        debug(err);
        callback(err);
      } else {
        cache.set('users', data, cacheInterval, callback);
      }
    });
  });
};

/**
 * Get a channel by id
 *
 * @param channelId
 * @param callback
 */
var getChannel = function (channelId, callback) {
  cache.get('channels', function (err, channelObj) {
    if (channelObj == undefined) {
      cb = function (err, results) {
        getChannel(channelId, callback);
      };

      cacheChannels(cb);
    } else {
      var channel = _.find(channelObj.channels, function (channel) {
        return channel.id == channelId;
      });
      callback(channel);
    }
  });
};

/**
 * Just get the users.
 *
 * @param findBy  constant to use for searching
 * @param value value to search by
 * @param callback
 */
var getUser = function (findBy, value, callback) {
  if (findBy == FIND_BY_EMAIL && value.indexOf('@') > 0) {
    cache.get('users', function (err, userObj) {
      if (userObj == undefined) {
        cb = function (err, results) {
          getUser(findBy, value, callback);
        };

        cacheUsers(cb);
      } else {
        var member = undefined;

        if (findBy == FIND_BY_EMAIL) {
          member = _.find(userObj.members, function (member) {
            return member.profile.email == value
          });
        }
        callback(!member ? value + " not mapped to user" : null, member);
      }
    });
  } else if (findBy == FIND_BY_ID && value.indexOf('U') == 0 && value.length == 9) {
    cache.get('ID:' + value, function (err, userObj) {
      if (userObj == undefined) {
        cb = function (err, results) {
          getUser(findBy, value, callback);
        };

        cacheUsers(cb);
      } else {
        callback(!userObj ? value + " not mapped to user" : null, userObj);
      }
    });
  } else if (findBy == FIND_BY_NAME && !(value.indexOf('U') == 0 && value.length == 9)) {
    cache.get(value, function (err, userObj) {
      if (userObj == undefined) {
        cb = function (err, results) {
          getUser(findBy, value, callback);
        };

        cacheUsers(cb);
      } else {
        callback(!userObj ? value + " not mapped to user" : null, userObj);
      }
    });
  }
};

var writeConfig = function (callback) {
  fs.writeFile(config.util.getConfigSources()[0].name, JSON.stringify(config, null, 2), function (err) {
    if (err) throw err;
  });
};

/**
 * Return who's on call.
 *
 * @param callback
 */
var getOnCallSlackers = function (callback) {
  callback(oncallSlackers);
};

/**
 *  Start the bot
 */
bot.on('start', function () {

  async.series([
    function (callback) {
      cacheUsers(callback);
    },
    function (callback) {
      cacheChannels(callback);
    },
    function (callback) {
      getOnCallSlackers(callback);
    }
  ], function () {
    var msg = config.get('slack.welcome_message').trim();
    if (msg.length > 0) {
      messageOnCalls(config.get('slack.welcome_message'));
    }
  });
});

bot.on('message', function (data) {
    // all ingoing events https://api.slack.com/rtm
    if (data.type == 'message') {
      var notABot = (data.bot_id == undefined);
      var message = data.text ? data.text.trim() : '';

      var botTag = '<@' + bot.self.id + '>';
      var botTagIndex = message.indexOf(botTag);

      // check if we need to look up a bot by it's username
      var username = '';
      var enableBotBotComm = false;
      if (botTagIndex <= 0 && message.indexOf('<@') == 0) {
        var userNameData = message.match(/^<@(.*?)>/g);
        username = (userNameData && userNameData[0].replace(/[<@>]/g, ''));
        getUser(FIND_BY_NAME, username, function (err, user) {
          if (user && user.is_bot) {
            botTag = '<@' + user.id + '>';
            enableBotBotComm = true;
          }
        });
      }

      // handle normal channel interaction
      if ((notABot || data.bot_id != bot.self.id)
        && (botTagIndex >= 0 || enableBotBotComm)) {
        getChannel(data.channel, function (channel) {
          if (channel) {
            if (message.match(new RegExp('^' + botTag + ':? who$'))) { // who command
              postMessage(data.channel, '', 'are the humans OnCall.', false);
            }
            else if (message.match(new RegExp('^' + botTag + ':?$'))) { // need to support mobile which adds : after a mention
              mentionOnCalls(channel.name, "get in here! :point_up_2:");
            }
            else {  // default
              preText = (data.user ? ' <@' + data.user + '>' : botTag) + ' said _"';
              if (botTagIndex == 0) {
                mentionOnCalls(channel.name, preText + message.substr(botTag.length + 1) + '_"');
              } else if (data.user || enableBotBotComm) {
                message = message.replace(/^<@(.*?)> +/, '');  // clean up spacing
                mentionOnCalls(channel.name, preText + message + '_"');
              }
            }
          }
        });
      }
      // handle direct bot interaction
      else if (notABot) {
        getChannel(data.channel, function (channel) {
          if (!channel) {
            getUser(FIND_BY_ID, data.user, function (err, user) {
              if (err) {
                debug(err);
                return;
              }

              if (message.match(WHO_REGEX)) { // who command
                postMessage(user.name, '', 'are the humans OnCall.', true);
              }
              else if (message.match(VERSION_REGEX)) { // version command
                bot.postMessageToUser(user.name, 'I am *' + pjson.name + '* and running version ' + pjson.version + '.', {icon_emoji: iconEmoji});
              }
              else if (message.match(ADD_USER_REGEX) || message.match(ADD_USERID_REGEX)) { // add user
                var addUser = message.match(ADD_USER_REGEX) ? message.match(ADD_USER_REGEX)[1] : null;
                var tempAddUser = null;
                var addUserId = message.match(ADD_USERID_REGEX);
                if (addUser) {
                  getUser(FIND_BY_NAME, addUser, function (err, user) {
                    if (user) {
                      addUser = user.name;
                    } else {
                      tempAddUser = addUser;
                      addUser = null;
                    }
                  });
                }
                else if (addUserId) {
                  getUser(FIND_BY_ID, addUserId[1], function (err, user) {
                    addUser = user.name;
                  });
                }

                if (addUser && oncallSlackers.indexOf(addUser) == -1) {
                  oncallSlackers.push(addUser);
                  writeConfig(new function () {
                    bot.postMessageToUser(user.name, addUser + ' was added.', {icon_emoji: iconEmoji});
                  });
                } else if (oncallSlackers.indexOf(addUser) > 0) {
                  bot.postMessageToUser(user.name, addUser + ' already exists.', {icon_emoji: iconEmoji});
                } else if (!addUser && tempAddUser) {
                  bot.postMessageToUser(user.name, "Sorry, didn't find a user with the name *" + tempAddUser + "* to add.", {icon_emoji: iconEmoji});
                }
              }
              else if (message.match(REMOVE_USER_REGEX) || message.match(REMOVE_USERID_REGEX)) { // remove user
                var removeUser = message.match(REMOVE_USER_REGEX) ? message.match(REMOVE_USER_REGEX)[1] : null;
                var removeUserId = message.match(REMOVE_USERID_REGEX);
                if (removeUserId) {
                  getUser(FIND_BY_ID, removeUserId[1], function (err, user) {
                    removeUser = user.name;
                  });
                }

                var userIndex = oncallSlackers.indexOf(removeUser);
                if (userIndex != -1) {
                  oncallSlackers.splice(userIndex, 1);

                  writeConfig(new function () {
                    bot.postMessageToUser(user.name, removeUser + ' was removed.', {icon_emoji: iconEmoji});
                  });
                }
              }
              else if (message.match(HELP_REGEX)) { // help command
                bot.postMessageToUser(user.name, "I understand the following direct commands: *help*, *who*, *add <user>*, *remove <user>* & *version*.", {icon_emoji: iconEmoji});
              }
            });
          }
        });
      }
    }
  }
);

