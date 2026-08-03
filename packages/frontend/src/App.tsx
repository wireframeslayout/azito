import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { TokenGate } from './components/TokenGate';
import './styles/global.css';

export default function App() {
  return (
    <TokenGate>
      <RouterProvider router={router} />
    </TokenGate>
  );
}
