// models/DirectorChange.js (CommonJS)
const mongoose = require('mongoose');

const DirectorChangeSchema = new mongoose.Schema(
  {
    company_number: { type: String, required: true },
    event_date:     { type: Date,   required: true }, // single date used for filters/sort
    change_type:    { type: String, enum: ['Appointed','Resigned','RoleChanged','Other'], required: true },
    officer_name:   { type: String, required: true },
    officer_role:   { type: String, default: null },
    details:        { type: String, default: null },
    source:         { type: String, default: null }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'director_changes' // <- exact collection name your API expects
  }
);

// Helpful index for your queries
DirectorChangeSchema.index({ company_number: 1, event_date: -1 });

module.exports = mongoose.model('DirectorChange', DirectorChangeSchema);
