// Pull contact info (email, first/last name, phone) out of a Jotform submission.
//
// This is a dependency-free twin of extractClientInfo() in api/recommend.mjs.
// We deliberately DON'T import that one here: recommend.mjs loads sharp,
// heic-convert, the Anthropic SDK and reads a file at import time, and pulling
// all of that into the lightweight Kit webhook/cron would bloat their cold
// start for no reason. Keep this small and side-effect free.
//
// Returns names in the shape tagSubscriber() wants: { firstName, lastName }.
export function extractContact(submission) {
  const answers = submission?.answers || {};
  const info = { firstName: '', lastName: '', email: '', phone: '' };

  for (const field of Object.values(answers)) {
    if (!field || !field.answer) continue;

    const name = (field.name || '').toLowerCase();
    const type = (field.type || '').toLowerCase();

    if (type === 'control_fullname' || name.includes('name')) {
      if (typeof field.answer === 'object') {
        info.firstName = info.firstName || field.answer.first || '';
        info.lastName = info.lastName || field.answer.last || '';
      }
    }
    if (name === 'firstname' || name === 'first_name') {
      info.firstName = info.firstName || String(field.answer);
    }
    if (name === 'lastname' || name === 'last_name') {
      info.lastName = info.lastName || String(field.answer);
    }
    if (type === 'control_email' || name.includes('email')) {
      info.email = info.email || String(field.answer);
    }
    if (type === 'control_phone' || name.includes('phone')) {
      const phone = field.prettyFormat || field.answer;
      info.phone = info.phone || String(typeof phone === 'object' ? Object.values(phone).join('') : phone);
    }
  }

  info.email = info.email.trim();
  info.firstName = info.firstName.trim();
  info.lastName = info.lastName.trim();
  info.phone = info.phone.trim();
  return info;
}
