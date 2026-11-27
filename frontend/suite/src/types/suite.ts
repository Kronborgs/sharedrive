export type SuiteModule = 'mail' | 'calendar' | 'contacts';

export interface ToastMessage {
  id: string;
  title: string;
  detail?: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export interface SuiteConfig {
  hasDefaultServer: boolean;
  enabledModules: SuiteModule[];
  sogoUrl: string | null;
}
