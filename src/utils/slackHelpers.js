/**
 * Parse a Slack user ID from a mention string
 * Handles various formats of user mentions that Slack might send
 */
function parseUserId(mention) {
  if (!mention) return null;
  
  console.log(`Parsing user mention: ${mention}`);
  
  // If it's already a plain ID
  if (/^[A-Z0-9]{9,}$/.test(mention)) {
    return mention;
  }
  
  // Handle <@UserId> format
  const match = mention.match(/^<@([A-Z0-9]{9,})>$/);
  if (match) {
    return match[1];
  }
  
  // Handle <@UserId|username> format
  const complexMatch = mention.match(/^<@([A-Z0-9]{9,})\|.*>$/);
  if (complexMatch) {
    return complexMatch[1];
  }
  
  // Handle plain @username format - this requires an API call to resolve
  // We'll mark it for further processing
  if (mention.startsWith('@')) {
    // Return a special value to indicate we need to look up this username
    return `LOOKUP:${mention.substring(1)}`;
  }
  
  return null;
}

/**
 * Convert a username to a user ID using the Slack API
 * Use this when parseUserId returns a value starting with "LOOKUP:"
 */
async function usernameToId(username, client) {
  try {
    // Try to find in user list first (more reliable)
    console.log(`Searching for user by name: ${username}`);
    const userList = await client.users.list();
    
    // Try various matching strategies
    const user = userList.members.find(m => {
      // Match by username
      if (m.name === username || m.name === username.toLowerCase()) {
        return true;
      }
      
      // Match by display name
      if (m.profile && m.profile.display_name && 
         (m.profile.display_name === username || 
          m.profile.display_name.toLowerCase() === username.toLowerCase() ||
          m.profile.display_name.includes(username))) {
        return true;
      }
      
      // Match by real name
      if (m.real_name && 
         (m.real_name === username || 
          m.real_name.toLowerCase().includes(username.toLowerCase()))) {
        return true;
      }
      
      return false;
    });
    
    if (user && user.id) {
      console.log(`Found user with ID: ${user.id} for username: ${username}`);
      return user.id;
    }
  } catch (error) {
    console.error(`Error searching for user ${username} in user list:`, error);
  }
  
  // As a fallback, try email lookup if we can guess their email
  try {
    // Skip this if the username looks like it might not be a valid email prefix
    if (username.match(/^[a-zA-Z0-9_.+-]+$/)) {
      console.log(`Trying email lookup for: ${username}`);
      
      // Try common domain patterns - you may need to adjust this for your organization
      const domains = [
        "yourdomain.com", 
        process.env.EMAIL_DOMAIN // Optional: Configure this in your .env file
      ].filter(Boolean);
      
      for (const domain of domains) {
        try {
          const result = await client.users.lookupByEmail({
            email: `${username}@${domain}`
          });
          
          if (result && result.user && result.user.id) {
            console.log(`Found user with ID: ${result.user.id} using email: ${username}@${domain}`);
            return result.user.id;
          }
        } catch (err) {
          // Just continue to the next domain
        }
      }
    }
  } catch (error) {
    console.error(`Error looking up user ID for ${username} by email:`, error);
  }
  
  console.log(`Could not find user ID for username: ${username}`);
  return null;
}

/**
 * Format a timestamp for display
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Calculate time elapsed since a timestamp
 */
function timeElapsedSince(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diff = now - then; // difference in milliseconds
  
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
  
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) {
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  }
  
  const days = Math.floor(diff / 86400000);
  return `${days} day${days !== 1 ? 's' : ''}`;
}

module.exports = {
  parseUserId,
  usernameToId,
  formatTimestamp,
  timeElapsedSince
}; 