import "../styles/globals.css";
import "../styles/app-shell.css";
import "../styles/frontdesk-registration.css";
import "../styles/queue-ticket.css";
import { AuthProvider } from "../context/AuthContext";

export default function App({ Component, pageProps }) {
  return (
    <AuthProvider>
      <Component {...pageProps} />
    </AuthProvider>
  );
}
