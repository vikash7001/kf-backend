const { supabase } = require('./supabaseClient');

async function logActivity({
  userId,
  username,
  actionType,
  description
}) {
  const { error } = await supabase
    .from('tblactivitylog')
    .insert([{
      user_id: userId,
      username: username,
      actiontype: actionType,
      description: description,
      actiontime: new Date()
    }]);

  if (error) {
    console.error('Activity log failed:', error);
  }
}

module.exports = {
  logActivity
};
