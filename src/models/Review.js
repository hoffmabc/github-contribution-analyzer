const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  requesterId: {
    type: String,
    required: true,
    index: true
  },
  requesterName: {
    type: String,
    required: true
  },
  reviewerId: {
    type: String,
    required: true,
    index: true
  },
  reviewerName: {
    type: String,
    required: true
  },
  prUrl: {
    type: String,
    required: true
  },
  requestedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  completedAt: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'cancelled'],
    default: 'pending',
    index: true
  },
  lastReminderSent: {
    type: Date,
    default: null
  },
  reminderCount: {
    type: Number,
    default: 0
  },
  channelId: {
    type: String,
    required: true
  },
  messageTs: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Add method to mark review as completed
reviewSchema.methods.markAsCompleted = function() {
  this.status = 'completed';
  this.completedAt = new Date();
  return this.save();
};

// Add method to mark review as cancelled
reviewSchema.methods.markAsCancelled = function() {
  this.status = 'cancelled';
  return this.save();
};

// Add method to update reminder information
reviewSchema.methods.updateReminder = function() {
  this.lastReminderSent = new Date();
  this.reminderCount += 1;
  return this.save();
};

// Static method to find pending reviews for a specific user
reviewSchema.statics.findPendingForUser = function(userId) {
  return this.find({
    reviewerId: userId,
    status: 'pending'
  }).sort({ requestedAt: 1 });
};

// Static method to find reviews that need reminders
reviewSchema.statics.findNeedingReminders = function(thresholdHours = 24) {
  const threshold = new Date();
  threshold.setHours(threshold.getHours() - thresholdHours);
  
  return this.find({
    status: 'pending',
    $or: [
      { lastReminderSent: null, requestedAt: { $lt: threshold } },
      { lastReminderSent: { $lt: threshold } }
    ]
  }).sort({ requestedAt: 1 });
};

const Review = mongoose.model('Review', reviewSchema);

module.exports = Review; 