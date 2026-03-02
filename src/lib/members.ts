import membersData from '../data/members.json';

export type MemberGroup = 'pi' | 'phd' | 'masters' | 'undergrad' | 'collaborators';

export interface Member {
  id: string;
  name: string;
  role: string;
  photo?: string | null;
  bio?: string | null;
  website?: string | null;
  email?: string | null;
  institution?: string;
}

const pi: Member = membersData.pi;
const students: Member[] = [
  ...membersData.phd,
  ...membersData.masters,
  ...membersData.undergrad,
];
const all: Member[] = [pi, ...students, ...membersData.collaborators];

const byId = new Map<string, Member>(all.map((m) => [m.id, m]));

export function getMember(id: string): Member | undefined {
  return byId.get(id);
}

export function getGroup(group: MemberGroup): Member[] {
  if (group === 'pi') return [pi];
  return membersData[group] as Member[];
}

export function getAllMembers(): Member[] {
  return all;
}

export function getLabMembers(): Member[] {
  return [pi, ...students];
}

export function getLabMemberCount(): number {
  return 1 + students.length;
}

export function getCollaboratorCount(): number {
  return membersData.collaborators.length;
}

export function getPiName(): string {
  return pi.name;
}
