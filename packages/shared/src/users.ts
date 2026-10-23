/** Benutzerverwaltung: Anmeldung per Namensauswahl und 4-stelliger PIN. */

export interface User {
  id: number;
  firstName: string;
  lastName: string;
  isAdmin: boolean;
  createdAt: string;
  createdBy: string;
  lastLoginAt: string | null;
}

/** Öffentlich für die Namensauswahl beim Anmelden. */
export interface LoginCandidate {
  id: number;
  firstName: string;
  lastName: string;
}

export interface AuthStatus {
  /** false beim allerersten Start – dann wird der erste Admin angelegt. */
  hasUsers: boolean;
  user: User | null;
}

export interface NewUser {
  firstName: string;
  lastName: string;
  pin: string;
  isAdmin?: boolean;
}

export interface UserPatch {
  firstName?: string;
  lastName?: string;
  isAdmin?: boolean;
  /** Neue PIN (nur Admins für andere Benutzer). */
  pin?: string;
}

export const PIN_PATTERN = /^\d{4}$/;

export const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`;
