import Link from 'next/link';
import {
  Check,
  ChevronRight,
  Download,
  Fingerprint,
  Home,
  LogOut,
  Palette,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserMinus,
  X,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import type {
  Household,
  HouseholdCategory,
  Member,
} from '@/lib/splitmate-models';
import { Avatar } from './avatar';

type SettingsViewProps = {
  user: User;
  self: Member;
  household: Household;
  isAdmin: boolean;
  isOwner: boolean;
  profileName: string;
  householdName: string;
  newCategory: string;
  categories: HouseholdCategory[];
  theme: 'system' | 'light' | 'dark';
  passkeyConfigured: boolean;
  passkeyBusy: boolean;
  deletingAccount: boolean;
  onProfileName: (value: string) => void;
  onHouseholdName: (value: string) => void;
  onNewCategory: (value: string) => void;
  onTheme: (value: 'system' | 'light' | 'dark') => void;
  onSaveProfile: () => void;
  onSaveHousehold: () => void;
  onAddCategory: () => void;
  onDeleteCategory: (category: HouseholdCategory) => void;
  onRegisterPasskey: () => void;
  onExport: () => void;
  onLeave: () => void;
  onDeleteAccount: () => void;
  onSignOut: () => void;
};

export function SettingsView(props: SettingsViewProps) {
  const {
    user,
    self,
    household,
    isAdmin,
    isOwner,
    profileName,
    householdName,
    newCategory,
    categories,
    theme,
    passkeyConfigured,
    passkeyBusy,
    deletingAccount,
    onProfileName,
    onHouseholdName,
    onNewCategory,
    onTheme,
    onSaveProfile,
    onSaveHousehold,
    onAddCategory,
    onDeleteCategory,
    onRegisterPasskey,
    onExport,
    onLeave,
    onDeleteAccount,
    onSignOut,
  } = props;
  return (
    <section className="single-column settings-page">
      <div className="settings-profile">
        <Avatar member={self} />
        <div>
          <strong>
            {self.name}{' '}
            <span className={`role-pill ${self.role}`}>{self.role}</span>
          </strong>
          <span>{user.email}</span>
        </div>
      </div>
      <div>
        <p className="settings-label">Profile</p>
        <div className="settings-group">
          <label className="inline-setting">
            <span className="settings-icon">
              <Pencil size={18} />
            </span>
            <input
              value={profileName}
              onChange={(event) => onProfileName(event.target.value)}
              maxLength={50}
              aria-label="Display name"
            />
            <button
              disabled={!profileName.trim() || profileName.trim() === self.name}
              onClick={onSaveProfile}
            >
              Save
            </button>
          </label>
          {isAdmin && (
            <label className="inline-setting">
              <span className="settings-icon">
                <Home size={18} />
              </span>
              <input
                value={householdName}
                onChange={(event) => onHouseholdName(event.target.value)}
                maxLength={60}
                aria-label="Household name"
              />
              <button
                disabled={
                  !householdName.trim() ||
                  householdName.trim() === household.name
                }
                onClick={onSaveHousehold}
              >
                Save
              </button>
            </label>
          )}
        </div>
      </div>
      {isAdmin && (
        <div>
          <p className="settings-label">Categories</p>
          <div className="settings-group">
            <label className="inline-setting">
              <span className="settings-icon">
                <Plus size={19} />
              </span>
              <input
                value={newCategory}
                onChange={(event) => onNewCategory(event.target.value)}
                maxLength={30}
                placeholder="New category"
                aria-label="New category"
              />
              <button disabled={!newCategory.trim()} onClick={onAddCategory}>
                Add
              </button>
            </label>
            {categories.map((category) => (
              <div className="settings-row compact-setting" key={category.id}>
                <span>{category.name}</span>
                <button
                  aria-label={`Delete ${category.name}`}
                  onClick={() => onDeleteCategory(category)}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div>
        <p className="settings-label">Appearance</p>
        <div className="settings-group">
          <div className="settings-row">
            <span className="settings-icon">
              <Palette size={19} />
            </span>
            <div>
              <strong>Appearance</strong>
              <small>Choose how SplitMate looks.</small>
            </div>
            <div className="theme-picker" aria-label="Appearance">
              {(['system', 'light', 'dark'] as const).map((value) => (
                <button
                  key={value}
                  className={theme === value ? 'selected' : ''}
                  onClick={() => onTheme(value)}
                >
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div>
        <p className="settings-label">Security</p>
        <div className="settings-group">
          {typeof PublicKeyCredential !== 'undefined' &&
            (passkeyConfigured ? (
              <div className="settings-row passkey-ready">
                <span className="settings-icon">
                  <Check size={20} />
                </span>
                <div>
                  <strong>Passkey is set up</strong>
                  <small>Face ID or your device passkey can sign you in.</small>
                </div>
              </div>
            ) : (
              <button
                className="settings-row settings-button"
                disabled={passkeyBusy}
                onClick={onRegisterPasskey}
              >
                <span className="settings-icon">
                  <Fingerprint size={20} />
                </span>
                <div>
                  <strong>
                    {passkeyBusy
                      ? 'Opening security check…'
                      : 'Set up Face ID or passkey'}
                  </strong>
                  <small>Sign in without entering your password.</small>
                </div>
                <ChevronRight size={18} />
              </button>
            ))}
          <div className="settings-row">
            <span className="settings-icon">
              <ShieldCheck size={19} />
            </span>
            <div>
              <strong>Private household</strong>
              <small>Only members can see receipts and balances.</small>
            </div>
          </div>
        </div>
      </div>
      <div>
        <p className="settings-label">Data & privacy</p>
        <div className="settings-group">
          <button className="settings-row settings-button" onClick={onExport}>
            <span className="settings-icon">
              <Download size={19} />
            </span>
            <div>
              <strong>Export expenses</strong>
              <small>Download a portable CSV backup.</small>
            </div>
            <ChevronRight size={18} />
          </button>
          <Link
            className="settings-row settings-button settings-link"
            href="/privacy"
          >
            <span className="settings-icon">
              <ShieldCheck size={19} />
            </span>
            <div>
              <strong>Privacy & receipt scanning</strong>
              <small>See what is stored and sent for OCR.</small>
            </div>
            <ChevronRight size={18} />
          </Link>
        </div>
      </div>
      <div>
        <p className="settings-label">Account</p>
        <div className="settings-group">
          <button
            className="settings-row settings-button danger-row"
            onClick={onLeave}
          >
            <span className="settings-icon">
              <UserMinus size={19} />
            </span>
            <div>
              <strong>
                {isOwner ? 'Delete household' : 'Leave household'}
              </strong>
              <small>
                {isOwner
                  ? 'Only possible when no other members remain.'
                  : 'Remove your account from this household.'}
              </small>
            </div>
            <ChevronRight size={18} />
          </button>
          <button
            className="settings-row settings-button danger-row"
            disabled={deletingAccount}
            onClick={onDeleteAccount}
          >
            <span className="settings-icon">
              <Trash2 size={19} />
            </span>
            <div>
              <strong>
                {deletingAccount
                  ? 'Deleting account…'
                  : 'Permanently delete account'}
              </strong>
              <small>Deletes your login and personal account data.</small>
            </div>
            <ChevronRight size={18} />
          </button>
          <button
            className="settings-row settings-button danger-row"
            onClick={onSignOut}
          >
            <span className="settings-icon">
              <LogOut size={19} />
            </span>
            <div>
              <strong>Sign out</strong>
              <small>Keep this device’s data private.</small>
            </div>
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <p className="settings-footer">SplitMate · Household bills, sorted.</p>
    </section>
  );
}
