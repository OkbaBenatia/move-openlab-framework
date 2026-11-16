import { createContext } from 'react';
import type { User } from './api/client';

export const UserContext = createContext<User | null>(null);
