import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { ROUTE_PATHS } from './paths';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      ...ROUTE_PATHS.map((path) => ({ path, element: null as ReactNode })),
      { path: '/workspace', element: <Navigate to="/" replace /> },
      { path: '/tasks', element: <Navigate to="/" replace /> },
    ],
  },
]);
