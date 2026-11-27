export interface AddressBook {
  id: string;
  url: string;
  name: string;
  readOnly: boolean;
  isShared: boolean;
  owner?: string;
  ctag?: string;
  description?: string;
}

export interface ContactEmail {
  type: 'work' | 'home' | 'other';
  value: string;
  pref?: boolean;
}

export interface ContactPhone {
  type: 'mobile' | 'work' | 'home' | 'other';
  value: string;
  pref?: boolean;
}

export interface ContactAddress {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface Contact {
  id: string;
  uid: string;
  addressBookId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  nickname?: string;
  organization?: string;
  title?: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  birthday?: string;
  anniversary?: string;
  anniversaryLabel?: string;
  address?: ContactAddress;
  website?: string;
  notes?: string;
  categories: string[];
  starred?: boolean;
  photoDataUrl?: string | null;
  vcardUrl?: string;
  etag?: string;
  rawVcard?: string;
  updatedAt?: string;
}
