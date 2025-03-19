/**
 * Validate that a string is a valid PR URL
 * Supports GitHub, GitLab, and Bitbucket
 */
function validatePrUrl(url) {
  if (!url) return false;
  
  // Basic URL validation
  try {
    new URL(url);
  } catch (error) {
    return false;
  }
  
  // Check for common PR URL patterns
  const prPatterns = [
    // GitHub
    /github\.com\/.*\/.*\/pull\/\d+/i,
    // GitLab
    /gitlab\.com\/.*\/.*\/-\/merge_requests\/\d+/i,
    // Bitbucket
    /bitbucket\.org\/.*\/.*\/pull-requests\/\d+/i,
    // Azure DevOps
    /dev\.azure\.com\/.*\/_git\/.*\/pullrequest\/\d+/i,
  ];
  
  return prPatterns.some(pattern => pattern.test(url));
}

module.exports = {
  validatePrUrl
}; 