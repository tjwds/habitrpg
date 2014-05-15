var mongoose = require("mongoose");
var Schema = mongoose.Schema;
var shared = require('habitrpg-shared');
var _ = require('lodash');
var TaskSchemas = require('./task');
var Habit = TaskSchemas.HabitModel,
  Daily = TaskSchemas.DailyModel,
  Todo = TaskSchemas.TodoModel,
  Reward = TaskSchemas.RewardModel

var ChallengeSchema = new Schema({
  _id: {type: String, 'default': shared.uuid},
  name: String,
  shortName: String,
  description: String,
  official: {type: Boolean,'default':false},
  habits:   Schema.Types.Mixed,
  dailys:   Schema.Types.Mixed,
  todos:    Schema.Types.Mixed,
  rewards:  Schema.Types.Mixed,
  leader: {type: String, ref: 'User'},
  group: {type: String, ref: 'Group'},
  timestamp: {type: Date, 'default': Date.now},
  members: [{type: String, ref: 'User'}],
  memberCount: {type: Number, 'default': 0},
  prize: {type: Number, 'default': 0}
});

ChallengeSchema.virtual('tasks').get(function () {
  return shared.refMerge(this.habits, this.dailys, this.todos, this.rewards);
//  var tasks = this.habits.concat(this.dailys).concat(this.todos).concat(this.rewards);
//  var tasks = _.object(_.pluck(tasks,'id'), tasks);
//  return tasks;
});

ChallengeSchema.methods.toJSON = function(){
  var doc = this.toObject();
  doc._isMember = this._isMember;
  return doc;
}

var taskFromArr = function(arr){
  return _.reduce(arr, function(m,v){
    var task = new {habit:Habit,daily:Daily,todo:Todo,reward:Reward}[v.type](v);
    m[task.id] = task; return m;
  }, {});
}
ChallengeSchema.pre('validate',function(next){
  var that = this;
  _.each(['habits','dailys','todos','rewards'], function(type){
    if (_.isArray(that[type])) that[type] = taskFromArr(that[type]);
  })
  next();
})

//ChallengeSchema.pre('validate',function(next){
//  console.log(this);
//})

ChallengeSchema.pre('save',function(next){
  var self = this;
  _.each({habits:Habit,dailys:Daily,todos:Todo,rewards:Reward},function(k,model){
    _.each(self[k], function(t){
      t = new model(t);
    });
  });
  next();
})

// --------------
// Syncing logic
// --------------

function syncableAttrs(task) {
  var t = (task.toObject) ? task.toObject() : task; // lodash doesn't seem to like _.omit on EmbeddedDocument
  // only sync/compare important attrs
  var omitAttrs = 'history tags completed streak notes'.split(' ');
  if (t.type != 'reward') omitAttrs.push('value');
  return _.omit(t, omitAttrs);
}

/**
 * Compare whether any changes have been made to tasks. If so, we'll want to sync those changes to subscribers
 */
function comparableData(obj) {
  return JSON.stringify(
    _(shared.refMerge(obj.habits,obj.dailys,obj.todos,obj.rewards))
      .toArray()
      .sortBy('id') // we don't want to update if they're sort-order is different
      .transform(function(result, task){
        result.push(syncableAttrs(task));
      })
      .value())
}

ChallengeSchema.methods.isOutdated = function(newData) {
  return comparableData(this) !== comparableData(newData);
}

/**
 * Syncs all new tasks, deleted tasks, etc to the user object
 * @param user
 * @return nothing, user is modified directly. REMEMBER to save the user!
 */
ChallengeSchema.methods.syncToUser = function(user, cb) {
  if (!user) return;
  var self = this;
  self.shortName = self.shortName || self.name;

  // Add challenge to user.challenges
  if (!_.contains(user.challenges, self._id)) {
      user.challenges.push(self._id);
  }

  // Sync tags
  var tags = user.tags || [];
  var i = _.findIndex(tags, {id: self._id})
  if (~i) {
    if (tags[i].name !== self.shortName) {
      // update the name - it's been changed since
      user.tags[i].name = self.shortName;
    }
  } else {
    user.tags.push({
      id: self._id,
      name: self.shortName,
      challenge: true
    });
  }

  // Sync new tasks and updated tasks
  _.each(self.tasks, function(task){
    var list = user[task.type+'s'];
    if (!user.tasks[task.id]) list[task.id] = syncableAttrs(task);
    var userTask = user.tasks[task.id];
    if (!userTask.notes) userTask.notes = task.notes; // don't override the notes, but provide it if not provided
    userTask.challenge = {id:self._id};
    userTask.tags = userTask.tags || {};
    userTask.tags[self._id] = true;
    _.merge(userTask, syncableAttrs(task));
    user.markModified(task.type+'s');
  })

  // Flag deleted tasks as "broken"
  _.each(user.tasks, function(task){
    if (task.challenge && task.challenge.id==self._id && !self.tasks[task.id]) {
      user[task.type+'s'][task.id].challenge.broken = 'TASK_DELETED';
      user.markModified(task.type+'s.'+task.id);
    }
  })

  user.save(cb);
};


module.exports.schema = ChallengeSchema;
module.exports.model = mongoose.model("Challenge", ChallengeSchema);