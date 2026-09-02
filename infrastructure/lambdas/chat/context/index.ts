import type { ChatApp } from '../../../schema/chat';
import { loadCalculation } from './calculator';
import { loadMom } from './mom';
import { loadIntelligenceEvaluation, loadInterviewEvaluation } from './evaluation';
import type { EntityContextResult } from './shared';

export type { EntityContext, EntityContextFailure, EntityContextResult } from './shared';

/**
 * Load and describe the artifact a thread is about, or say why it cannot be.
 *
 * The loader's reason is passed straight through rather than flattened. It used to be a
 * bare null covering all three failures — no such record, someone else's record, a record
 * with no result yet — on the theory that distinguishing them would let a probe learn
 * which ids exist. That theory did not survive comparison with the REST layer, which
 * answers a non-owner with 403 and an unknown id with 404 and has always done so. The
 * merge hid nothing from an attacker and hid the actual reason from the owner. See
 * `EntityContextResult` in shared.ts, and the branch in chat/index.ts that turns each
 * reason into a status code.
 *
 * Ownership itself is unchanged: every loader below still refuses a record it does not
 * belong to, with no admin fallback anywhere.
 */
export async function loadEntityContext(
  app: ChatApp,
  entityId: string,
  userId: string,
): Promise<EntityContextResult> {
  switch (app) {
    case 'calculator':
      return loadCalculation(entityId, userId);
    case 'mom':
      return loadMom(entityId, userId);
    case 'interview':
      return loadInterviewEvaluation(entityId, userId);
    case 'intelligence':
      return loadIntelligenceEvaluation(entityId, userId);
  }
}
