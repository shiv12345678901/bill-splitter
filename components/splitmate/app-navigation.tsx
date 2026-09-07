import {
  Camera,
  ChartNoAxesColumnIncreasing,
  Home,
  ImagePlus,
  ReceiptText,
  Settings2,
  Users,
} from 'lucide-react';
import type { AppTab } from '@/lib/splitmate-models';

export function AppHeader({
  householdName,
  title,
  showCapture,
  onCamera,
  onUpload,
}: {
  householdName: string;
  title: string;
  showCapture: boolean;
  onCamera: () => void;
  onUpload: () => void;
}) {
  return (
    <header className="topbar">
      <div>
        <p>{householdName}</p>
        <h1>{title}</h1>
      </div>
      {showCapture && (
        <div className="top-actions">
          <button
            onClick={onCamera}
            className="circle-button secondary"
            aria-label="Scan with camera"
          >
            <Camera size={20} />
          </button>
          <button
            onClick={onUpload}
            className="circle-button"
            aria-label="Choose bill from Photos"
          >
            <ImagePlus size={21} />
          </button>
        </div>
      )}
    </header>
  );
}

const tabs: Array<{ id: AppTab; label: string; icon: typeof Home }> = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'receipts', label: 'Receipts', icon: ReceiptText },
  { id: 'insights', label: 'Insights', icon: ChartNoAxesColumnIncreasing },
  { id: 'household', label: 'Household', icon: Users },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

export function BottomNavigation({
  active,
  onChange,
}: {
  active: AppTab;
  onChange: (tab: AppTab) => void;
}) {
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          aria-current={active === id ? 'page' : undefined}
          className={active === id ? 'active' : ''}
          onClick={() => onChange(id)}
        >
          <Icon size={21} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
