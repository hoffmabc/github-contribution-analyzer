const mongoose = require('mongoose');

/**
 * Schema for GitHub contribution reports
 */
const contributionReportSchema = new mongoose.Schema({
  // Store the entire report as a JSON document
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  generatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  // Enable timestamps for createdAt and updatedAt
  timestamps: true,
  // Add index on generatedAt for efficient queries
  indexes: [
    { generatedAt: -1 }
  ]
});

/**
 * Get recent reports from the database
 */
contributionReportSchema.statics.getRecentReports = function(limit = 5) {
  return this.find()
    .sort({ generatedAt: -1 })
    .limit(limit);
};

/**
 * Get a report by ID
 */
contributionReportSchema.statics.getReportById = function(id) {
  return this.findById(id);
};

/**
 * Get the latest report
 */
contributionReportSchema.statics.getLatestReport = function() {
  return this.findOne().sort({ generatedAt: -1 });
};

const ContributionReport = mongoose.model('ContributionReport', contributionReportSchema);

module.exports = ContributionReport; 