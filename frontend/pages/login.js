import { useEffect, useRef, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";
import SystemLogo from "../components/SystemLogo";
import { OFFICE_IDENTITY } from "../lib/branding";
import styles from "../styles/login.module.css";

// The photo is shown whole (never cropped) so the building sign and the
// photographer's watermark in the lower-right corner both stay visible.
const OFFICE_PHOTO = { src: "/cho_img.jpg", width: 1969, height: 1146 };

export default function Login() {
  const [idNum, setIdNum] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState("");
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const idRef = useRef(null);
  const passwordRef = useRef(null);
  const { login, user, loading: authLoading } = useAuth();
  const router = useRouter();

  // Redirect to appropriate page if already logged in
  useEffect(() => {
    setMounted(true);
    if (!authLoading && user) {
      if (user.role === "superadmin") {
        router.push("/");
      } else {
        if (user.id_num === "admin1") router.push("/admin1");
        else if (user.id_num === "admin2") router.push("/admin2");
        else if (user.id_num === "admin3") router.push("/admin3");
        else if (user.id_num === "frontdesk") router.push("/fill-up_form");
        else router.push("/");
      }
    }
  }, [user, authLoading, router]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;

    // Validation
    if (!idNum.trim()) {
      setError("Please enter your username/ID number");
      setInvalidField("id_num");
      idRef.current?.focus();
      return;
    }
    if (!password) {
      setError("Please enter your password");
      setInvalidField("password");
      passwordRef.current?.focus();
      return;
    }

    setError("");
    setInvalidField("");
    setLoading(true);

    try {
      const result = await login(idNum.trim(), password);
      if (!result.success) {
        setError(result.message || "Invalid credentials. Please try again.");
      }
    } catch (err) {
      setError("Network error. Please check your connection and try again.");
      console.error("Login error:", err);
    } finally {
      setLoading(false);
    }
  };

  const checkingSession = !mounted || authLoading;

  return (
    <>
      <Head>
        <title>{`Sign in | ${OFFICE_IDENTITY.fullName}`}</title>
      </Head>

      <div className={styles.page}>
        <section className={styles.visual} aria-label="City Health Office">
          <img
            className={styles.photo}
            src={OFFICE_PHOTO.src}
            width={OFFICE_PHOTO.width}
            height={OFFICE_PHOTO.height}
            alt="The Cabadbaran City Health Office and Family Planning Center building and its main sign"
            decoding="async"
            fetchPriority="high"
          />
          <div className={styles.visualText}>
            <p className={styles.visualSystem}>{OFFICE_IDENTITY.system}</p>
            <p className={styles.visualTagline}>Supporting organized and efficient healthcare services.</p>
            <p className={styles.visualPlace}>City of Cabadbaran</p>
          </div>
        </section>

        <main className={styles.panel}>
          <div className={styles.panelInner}>
            <div className={styles.brand}>
              <SystemLogo variant="login" decorative className={styles.logo} />
              <div className={styles.brandText}>
                <span className={styles.brandName}>{OFFICE_IDENTITY.name}</span>
                <span className={styles.brandCenter}>{OFFICE_IDENTITY.center}</span>
              </div>
            </div>

            {checkingSession ? (
              <div className={styles.checking} role="status">
                <span className={styles.spinnerDark} aria-hidden="true" />
                Checking your session…
              </div>
            ) : (
              <div className={styles.formArea}>
                <h1 className={styles.heading}>Welcome back</h1>
                <p className={styles.intro}>Sign in to access the {OFFICE_IDENTITY.system}.</p>
                <p className={styles.staffNote}>
                  <i className="fas fa-shield-alt" aria-hidden="true" />
                  For authorized City Health staff only.
                </p>

                {error ? (
                  <div id="login-error" className={styles.error} role="alert">
                    <i className="fas fa-exclamation-circle" aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                ) : null}

                <form onSubmit={handleSubmit} noValidate className={styles.form} aria-busy={loading}>
                  <div className={styles.field}>
                    <label htmlFor="id_num" className={styles.label}>Username / ID Number</label>
                    <input
                      ref={idRef}
                      id="id_num"
                      name="id_num"
                      type="text"
                      className={styles.input}
                      placeholder="Enter your username or ID number"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      disabled={loading}
                      value={idNum}
                      aria-invalid={invalidField === "id_num" ? true : undefined}
                      aria-describedby={invalidField === "id_num" ? "login-error" : undefined}
                      onChange={(e) => setIdNum(e.target.value)}
                    />
                  </div>

                  <div className={styles.field}>
                    <label htmlFor="password" className={styles.label}>Password</label>
                    <div className={styles.passwordBox}>
                      <input
                        ref={passwordRef}
                        id="password"
                        name="password"
                        type={showPassword ? "text" : "password"}
                        className={`${styles.input} ${styles.passwordInput}`}
                        placeholder="Enter your password"
                        autoComplete="current-password"
                        required
                        disabled={loading}
                        value={password}
                        aria-invalid={invalidField === "password" ? true : undefined}
                        aria-describedby={invalidField === "password" ? "login-error" : undefined}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                      <button
                        type="button"
                        className={styles.reveal}
                        onClick={() => setShowPassword((shown) => !shown)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        aria-pressed={showPassword}
                        aria-controls="password"
                      >
                        <i className={showPassword ? "fas fa-eye-slash" : "fas fa-eye"} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <button type="submit" className={styles.submit} disabled={loading}>
                    {loading ? (
                      <>
                        <span className={styles.spinner} aria-hidden="true" />
                        <span>Signing in…</span>
                      </>
                    ) : (
                      <span>Sign in</span>
                    )}
                  </button>
                </form>
              </div>
            )}

            <footer className={styles.footer}>
              {OFFICE_IDENTITY.fullName} · {OFFICE_IDENTITY.system}
            </footer>
          </div>
        </main>
      </div>
    </>
  );
}
