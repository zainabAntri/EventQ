/**
 * Spam and automation defence for the public submission endpoint.
 *
 * Pure functions over a string. No network, no database, no model — and that is
 * a deliberate product decision, not a shortcut: EventQ ships with AI disabled
 * and must stay fully functional that way, so the defence that runs on every
 * submission has to cost nothing. Everything here is arithmetic over one short
 * piece of text.
 *
 * The output is a VERDICT, not a decision. This module never rejects anything;
 * it reports what it noticed and the caller decides what that means for the
 * event's moderation mode. Keeping judgement separate from policy is what lets
 * the same signals drive a strict corporate town hall and a relaxed meetup.
 */

export type SpamVerdict = 'clean' | 'review' | 'spam';

export interface SpamAssessment {
  verdict: SpamVerdict;
  /** Signal names, recorded in the moderation audit trail so a moderator can
   *  see WHY something was held rather than facing an unexplained decision. */
  signals: string[];
  score: number;
}

export interface SpamHeuristicOptions {
  /** Mirrors EventSettings.profanityFilter. */
  profanityFilter: boolean;
}

/**
 * Weights.
 *
 * Tuned so that any single ordinary-looking trait only routes a question to a
 * human, while a combination — or one unambiguously hostile trait — quarantines
 * it. A question is never rejected outright by this module, so the cost of a
 * false positive is a short wait, not a lost contribution.
 */
const SCORES = {
  /** A scheme that only exists to execute or smuggle content. Decisive alone. */
  disallowedUrlScheme: 10,
  /**
   * Links, in three tiers rather than two.
   *
   * One link is plausible ("is the deck at this URL the final one?"). Two is
   * still possible, if someone is comparing things. Three or more is not a
   * question, and treating it the same as two meant an obvious advert only got
   * held for review. Tiering here rather than lowering the spam threshold keeps
   * a single ordinary link from ever being quarantined.
   */
  linkSpam: 8,
  excessiveLinks: 5,
  containsLink: 2,
  shouting: 2,
  repeatedCharacters: 3,
  lowAlphabeticRatio: 3,
  repeatedWord: 3,
  profanity: 4,
} as const;

const SPAM_THRESHOLD = 6;
const REVIEW_THRESHOLD = 2;

/**
 * Schemes that have no legitimate place in a typed question.
 *
 * `javascript:` and `vbscript:` execute. `data:` and `blob:` smuggle a payload
 * inline. `file:` points at the reader's own machine. None of these are ever
 * something an attendee means to ask about — and while EventQ renders question
 * text as text and never as a link, a URL that survives moderation and gets
 * copied by a reader is still a live phishing vector.
 */
const DISALLOWED_SCHEMES = /\b(?:javascript|vbscript|data|blob|file)\s*:/giu;

/** http/https with an authority, plus the bare `www.` and `host.tld/path` forms
 *  people actually type. */
const URL_LIKE =
  /\b(?:https?:\/\/\S+|www\.\S+|[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|dev|app|ai|xyz|info|biz|link|click|top|live|shop|online|site)(?:\/\S*)?)/giu;

/**
 * A deliberately SHORT starter list of unambiguous profanity.
 *
 * Not a moderation policy — a placeholder for one. Real deployments differ by
 * audience and language, and a long embedded English word list would create
 * false positives (the Scunthorpe problem, where an innocent word contains a
 * banned substring) while still missing most of what matters. Matched on whole
 * words only, for exactly that reason.
 *
 * Applied only when EventSettings.profanityFilter is on, and it only ever
 * routes a question to a human.
 */
const PROFANITY = new Set([
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'bastard',
  'cunt',
  'asshole',
  'dickhead',
  'wanker',
  'motherfucker',
]);

export function assessForSpam(
  body: string,
  normalizedBody: string,
  options: SpamHeuristicOptions,
): SpamAssessment {
  const signals: string[] = [];
  let score = 0;

  const add = (signal: string, weight: number): void => {
    signals.push(signal);
    score += weight;
  };

  // Reset lastIndex explicitly: these are module-level regexes with the /g flag,
  // which carry mutable state between calls. Forgetting this makes the SECOND
  // call on the same input return a different answer — a genuinely nasty bug in
  // something a security decision depends on.
  DISALLOWED_SCHEMES.lastIndex = 0;
  URL_LIKE.lastIndex = 0;

  if (DISALLOWED_SCHEMES.test(body)) {
    add('disallowed_url_scheme', SCORES.disallowedUrlScheme);
  }

  const links = body.match(URL_LIKE) ?? [];
  if (links.length >= 3) {
    add('link_spam', SCORES.linkSpam);
  } else if (links.length === 2) {
    add('excessive_links', SCORES.excessiveLinks);
  } else if (links.length === 1) {
    add('contains_link', SCORES.containsLink);
  }

  if (isShouting(body)) add('shouting', SCORES.shouting);
  if (hasCharacterRun(body)) add('repeated_characters', SCORES.repeatedCharacters);
  if (hasLowAlphabeticRatio(body)) add('low_alphabetic_ratio', SCORES.lowAlphabeticRatio);
  if (hasRepeatedWord(normalizedBody)) add('repeated_word', SCORES.repeatedWord);
  if (options.profanityFilter && containsProfanity(normalizedBody)) {
    add('profanity', SCORES.profanity);
  }

  return { verdict: verdictFor(score), signals, score };
}

function verdictFor(score: number): SpamVerdict {
  if (score >= SPAM_THRESHOLD) return 'spam';
  if (score >= REVIEW_THRESHOLD) return 'review';
  return 'clean';
}

/**
 * Sustained capitals. Short text is exempt because an acronym-heavy question
 * ("Is SaaS ARR a KPI?") is not shouting.
 */
function isShouting(body: string): boolean {
  const letters = [...body].filter((character) => /\p{L}/u.test(character));
  if (letters.length < 20) return false;

  const upper = letters.filter((character) => character === character.toUpperCase()).length;
  return upper / letters.length > 0.6;
}

/** "!!!!!!!!" or "aaaaaaaa" — a person emphasising, or a bot padding. */
function hasCharacterRun(body: string): boolean {
  return /(.)\1{7,}/u.test(body);
}

/**
 * Mostly not letters. Catches emoji walls and punctuation soup while leaving a
 * short numeric question alone.
 */
function hasLowAlphabeticRatio(body: string): boolean {
  const characters = [...body.replace(/\s/gu, '')];
  if (characters.length < 20) return false;

  const letters = characters.filter((character) => /\p{L}/u.test(character)).length;
  return letters / characters.length < 0.4;
}

/** The same word over and over, which is keyword stuffing rather than a question. */
function hasRepeatedWord(normalizedBody: string): boolean {
  const words = normalizedBody.split(' ').filter((word) => word.length > 2);
  if (words.length < 5) return false;

  const counts = new Map<string, number>();
  for (const word of words) {
    const next = (counts.get(word) ?? 0) + 1;
    if (next >= 5) return true;
    counts.set(word, next);
  }

  return false;
}

/** Whole-word match against the comparison form, which is already lowercased
 *  and stripped of punctuation. */
function containsProfanity(normalizedBody: string): boolean {
  return normalizedBody.split(' ').some((word) => PROFANITY.has(word));
}
