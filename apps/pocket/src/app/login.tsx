import { LoginScreen, useSession } from '@sgm/ui';
import { Redirect } from 'expo-router';

export default function Login() {
  const session = useSession();
  if (session) return <Redirect href="/" />;
  return <LoginScreen />;
}
