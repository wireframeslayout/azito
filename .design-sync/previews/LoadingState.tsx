import { LoadingState } from '@azito/frontend';

export const Default = () => <LoadingState />;

export const CustomMessage = () => <LoadingState message="Fetching sessions from wakanda…" />;
