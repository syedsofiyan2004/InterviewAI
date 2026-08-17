export function getIntelligenceCandidateName(item: any): string {
  if (!item) return 'Unnamed';

  let candidateObj = item.candidate;
  if (typeof candidateObj === 'string') {
    try { candidateObj = JSON.parse(candidateObj); } catch (_) {}
  }

  let jobObj = item.job;
  if (typeof jobObj === 'string') {
    try { jobObj = JSON.parse(jobObj); } catch (_) {}
  }

  let kekaObj = item.keka;
  if (typeof kekaObj === 'string') {
    try { kekaObj = JSON.parse(kekaObj); } catch (_) {}
  }

  let evalObj = item.aiEvaluation;
  if (typeof evalObj === 'string') {
    try { evalObj = JSON.parse(evalObj); } catch (_) {}
  }

  // 1. Direct candidate_name
  const name1 = item.candidate_name || item.candidateName || item.candidate_name_keka;
  if (name1 && typeof name1 === 'string' && name1.trim() && name1.trim().toLowerCase() !== 'unnamed') {
    return name1.trim();
  }

  // 2. candidate object
  const name2 = candidateObj?.name || candidateObj?.full_name || candidateObj?.candidate_name;
  if (name2 && typeof name2 === 'string' && name2.trim() && name2.trim().toLowerCase() !== 'unnamed') {
    return name2.trim();
  }

  // 3. keka object
  const name3 = kekaObj?.candidate_name || kekaObj?.candidateName || kekaObj?.name;
  if (name3 && typeof name3 === 'string' && name3.trim() && name3.trim().toLowerCase() !== 'unnamed') {
    return name3.trim();
  }

  // 4. aiEvaluation candidate_name
  const name4 = evalObj?.candidate_name || evalObj?.candidateName;
  if (name4 && typeof name4 === 'string' && name4.trim() && name4.trim().toLowerCase() !== 'unnamed') {
    return name4.trim();
  }

  // 5. aiEvaluation finalReport regex ("X was interviewed for...")
  if (evalObj?.finalReport && typeof evalObj.finalReport === 'string') {
    const match = evalObj.finalReport.match(/^([^]+?)\s+was interviewed/i);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
  }

  // 6. Job / Position title
  const title = item.position_title || jobObj?.title || item.title || item.keka_job_title || item.position;
  if (title && typeof title === 'string' && title.trim()) {
    return title.trim();
  }

  return 'Unnamed';
}
