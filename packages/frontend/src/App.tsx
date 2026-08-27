import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { TokenGate } from './components/TokenGate';
import { PushReconciler } from './components/PushReconciler';
import './styles/global.css';

export default function App() {
  return (
    <TokenGate>
      <PushReconciler />
      <RouterProvider router={router} />
    </TokenGate>
  );
}
