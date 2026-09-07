import type { Member } from '@/lib/splitmate-models';

export function Avatar({
  member,
  small = false,
}: {
  member: Pick<Member, 'name' | 'color'>;
  small?: boolean;
}) {
  const initials = member.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className={`avatar ${small ? 'avatar-small' : ''}`}
      style={{ background: member.color }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
