import Image from 'next/image';
import { Link2, RefreshCw, ShieldCheck, UserMinus } from 'lucide-react';
import type { Activity, Household, Member } from '@/lib/splitmate-models';
import { Avatar } from './avatar';

type HouseholdViewProps = {
  household: Household;
  members: Member[];
  self: Member;
  activities: Activity[];
  isAdmin: boolean;
  qrCode: string;
  onShareInvite: () => void;
  onRegenerateInvite: () => void;
  onRoleChange: (member: Member, role: Member['role']) => void;
  onRemoveMember: (member: Member) => void;
};

export function HouseholdView({
  household,
  members,
  self,
  activities,
  isAdmin,
  qrCode,
  onShareInvite,
  onRegenerateInvite,
  onRoleChange,
  onRemoveMember,
}: HouseholdViewProps) {
  return (
    <section className="single-column household-page">
      {isAdmin ? (
        <div className="invite-card invite-expanded">
          <div>
            <p>Invite to household</p>
            <strong>{household.join_code}</strong>
            <span>Share a secure link or let someone scan the code.</span>
            <div className="invite-actions">
              <button onClick={onShareInvite}>
                <Link2 size={17} /> Share invite
              </button>
              <button onClick={onRegenerateInvite}>
                <RefreshCw size={16} /> Replace
              </button>
            </div>
          </div>
          {qrCode && (
            <Image
              unoptimized
              width={240}
              height={240}
              src={qrCode}
              alt="Household invitation QR code"
            />
          )}
        </div>
      ) : (
        <div className="permission-card">
          <ShieldCheck size={20} />
          <div>
            <strong>Invites are managed by admins</strong>
            <span>Ask an admin to invite someone new.</span>
          </div>
        </div>
      )}
      <div className="section-heading">
        <h2>Members</h2>
        <span>Every bill is split equally</span>
      </div>
      <div className="list-card">
        {members.map((member) => (
          <div className="member-row managed" key={member.id}>
            <Avatar member={member} />
            <div>
              <strong>
                {member.name}{' '}
                <span className={`role-pill ${member.role}`}>
                  {member.role}
                </span>
              </strong>
              <span>
                {member.user_id === self.user_id ? 'You' : 'Household member'}
              </span>
            </div>
            {isAdmin && (
              <div className="member-controls">
                <select
                  aria-label={`${member.name} role`}
                  value={member.role}
                  onChange={(event) =>
                    onRoleChange(member, event.target.value as Member['role'])
                  }
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                {member.user_id !== self.user_id && (
                  <button
                    onClick={() => onRemoveMember(member)}
                    aria-label={`Remove ${member.name}`}
                  >
                    <UserMinus size={18} />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {activities.length > 0 && (
        <div>
          <div className="section-heading">
            <h2>Activity</h2>
            <span>Latest changes</span>
          </div>
          <div className="list-card activity-list">
            {activities.slice(0, 12).map((activity) => (
              <div className="activity-row" key={activity.id}>
                <span className={`activity-dot ${activity.action}`} />
                <div>
                  <strong>
                    {activity.actor_name || 'SplitMate'} {activity.summary}
                  </strong>
                  <small>
                    {new Date(activity.created_at).toLocaleString('en-AU', {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
