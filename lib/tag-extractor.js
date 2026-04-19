/**
 * Hashtag extraction utilities
 */

const TAG_REGEX = /#(\w+)/g;

/**
 * Parse #tags from any text, return array of lowercase tags without #
 * @param {string} text - Text to extract hashtags from
 * @returns {string[]} Array of lowercase tags without # prefix
 */
export function extractHashtags(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const matches = text.matchAll(TAG_REGEX);
  const tags = [];

  for (const match of matches) {
    tags.push(match[1].toLowerCase());
  }

  return tags;
}

/**
 * Get tags from profile.bio field
 * @param {Object} profile - Profile object with bio field
 * @returns {string[]} Array of lowercase tags from bio
 */
export function extractTagsFromBio(profile) {
  if (!profile || !profile.bio) {
    return [];
  }

  return extractHashtags(profile.bio);
}

/**
 * Scan recent posts for hashtags, return unique tags
 * @param {Object[]} events - Array of post events with content field
 * @param {number} limit - Maximum number of posts to scan (default: 20)
 * @returns {string[]} Array of unique lowercase tags
 */
export function extractTagsFromPosts(events, limit = 20) {
  if (!events || !Array.isArray(events)) {
    return [];
  }

  const recentEvents = events.slice(0, limit);
  const allTags = new Set();

  for (const event of recentEvents) {
    if (event && event.content) {
      const tags = extractHashtags(event.content);
      for (const tag of tags) {
        allTags.add(tag);
      }
    }
  }

  return Array.from(allTags);
}

/**
 * Combine bio + posts tags, bio tags get 2x weight, return top 10 sorted by frequency
 * @param {Object} profile - Profile object with bio field
 * @param {Object[]} events - Array of post events
 * @returns {string[]} Top 10 tags sorted by frequency (bio tags weighted 2x)
 */
export function suggestTags(profile, events) {
  const tagCounts = new Map();

  // Extract bio tags with 2x weight
  const bioTags = extractTagsFromBio(profile);
  for (const tag of bioTags) {
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 2);
  }

  // Extract post tags with 1x weight
  const postTags = extractTagsFromPosts(events);
  for (const tag of postTags) {
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }

  // Sort by frequency (descending) and return top 10
  const sortedTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(entry => entry[0]);

  return sortedTags;
}
