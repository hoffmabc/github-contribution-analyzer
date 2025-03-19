const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  teamId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  reminderFrequencyHours: {
    type: Number,
    default: 24 // Default to daily reminders
  },
  reminderMessage: {
    type: String,
    default: "You have pending code reviews. Please take some time to review them."
  },
  reminderEnabled: {
    type: Boolean,
    default: true
  },
  reminderLimit: {
    type: Number,
    default: 3 // Maximum number of reminders to send for a review
  },
  customThankYouMessage: {
    type: String,
    default: "Thank you for completing the code review!"
  }
}, {
  timestamps: true
});

// Static method to get settings for a team, creating default settings if not exists
settingsSchema.statics.getForTeam = async function(teamId) {
  let settings = await this.findOne({ teamId });
  
  if (!settings) {
    settings = await this.create({ teamId });
  }
  
  return settings;
};

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings; 