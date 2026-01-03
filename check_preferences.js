const { sequelize, UserPreference } = require('./src/database');

async function checkPreferences() {
  try {
    await sequelize.authenticate();
    const prefs = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (prefs) {
      console.log('Current Preferences:');
      console.log('areAutomatedJobsEnabled:', prefs.areAutomatedJobsEnabled);
      console.log('appointmentReminderJobSchedule:', prefs.appointmentReminderJobSchedule);
      console.log('Full Prefs:', JSON.stringify(prefs.toJSON(), null, 2));
    } else {
      console.log('No preferences found.');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}

checkPreferences();
