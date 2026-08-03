import type { ReactNode } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import Layout from './components/Layout';
import { ROUTE_PATHS } from './paths';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: ROUTE_PATHS.map((path) => ({ path, element: null as ReactNode })),
  },
]);
