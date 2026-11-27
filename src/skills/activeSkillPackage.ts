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
