/**
 * Competency name hygiene (Part B).
 *
 * Its own module so the rule that fixes the reported defect can be unit-tested
 * without loading the Lambda handler or calling a model: the question bank's
 * topicTag labels ("1500+ VM Migrations", "3000 users", "Terraform 1.5") are
 * program details, headcounts, or tool versions — not capabilities a panel can
 * probe in conversation — and they used to reach the focus-area chips, the
 * interviewer guide, the coverage matrix, and the PDF report verbatim.
 *
 * The AI extraction is asked to normalise such labels; this is the deterministic
 * backstop that runs on every path (admin override, AI, inferred) so a bad label
 * cannot reach any of those surfaces even when the model cooperates poorly.
 */

/** True when a string reads like an assessable competency rather than a metric. */
export function isLikelyCompetency(raw: string): boolean {
  const name = (raw || '').trim();
  if (name.length < 3 || name.length > 60) return false;
  if (!/[a-zA-Z]/.test(name)) return false;            // must contain letters
  if (/^\d/.test(name)) return false;                  // leading quantity: "1500+ VM Migrations", "3000 users"
  if (/\d\s*\+/.test(name)) return false;              // "1500+", "10 +"
  if (/\b\d+\.\d+/.test(name)) return false;           // tool/version token: "Terraform 1.5", "OAuth 2.0"
  if (/\b\d{2,}\b/.test(name)) return false;           // standalone count: "3000 users", "500 servers"
  if (/\b\d+\s*(users?|people|engineers?|employees?|customers?|clients?|developers?|members?|servers?|nodes?|vms?|migrations?|tickets?|projects?)\b/i.test(name)) {
    return false;                                      // headcount / volume phrasing
  }
  return true;
}

/** Trim, de-duplicate (case-insensitive), reject non-competencies, cap at 12. */
export function validateCompetencies(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list || []) {
    const name = (raw || '').trim().replace(/\s+/g, ' ');
    if (!isLikelyCompetency(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 12) break;
  }
  return out;
}
