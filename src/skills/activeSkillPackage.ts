import type { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import type { SkillPackage } from './SkillPackage.ts';

interface SkillPackageAccess {
  activePackage(id: string): SkillPackage;
}

function providesPackages(session: object | undefined): session is SkillPackageAccess {
  return !!session && 'activePackage' in session && typeof session.activePackage === 'function';
}

/** Skill tools need access only to packages already pinned by this turn. */
export function activeSkillPackage(session: object | undefined, id: string): SkillPackage {
  if (!providesPackages(session)) throw new Error('Skill context is unavailable.');
  return session.activePackage(id);
}

/** Acquire the exact package active in a live turn. Resource tools and script runners call
 * assertActive after asynchronous admission and immediately before releasing bytes or launching
 * a process. A new activation cannot authorize work prepared against an earlier package. */
export function acquireActiveSkillPackage(
  turns: Pick<TurnContextCoordinator, 'contribution'>,
  turnId: string,
  id: string,
) {
  const current = () => activeSkillPackage(turns.contribution(turnId, 'skills'), id);
  const pinned = current();
  return {
    pinned,
    assertActive: () => {
      if (current() !== pinned) throw new Error('Skill activation changed during the operation.');
    },
  };
}
