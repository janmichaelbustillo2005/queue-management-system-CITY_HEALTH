import React, { createContext, useContext, useState, useEffect } from "react";
import { useRouter } from "next/router";
import { AUTH_SESSION_CHANGED_EVENT, request } from "../lib/api";
import { startAuthHeartbeat } from "../lib/authHeartbeat";
import { canRegisterPatients } from "../lib/navigation";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logoutError, setLogoutError] = useState("");
  const router = useRouter();

  useEffect(() => {
    const heartbeat = startAuthHeartbeat({
      request, storage: localStorage, eventTarget: window, visibilityTarget: document, timers: window
    });
    let synchronizedToken;
    function synchronizeSession() {
      const storedUser = localStorage.getItem("city_health_user");
      const token = localStorage.getItem("city_health_token");
      if (storedUser && token) {
        try {
          const savedUser = JSON.parse(storedUser);
          if (!savedUser || typeof savedUser !== "object" || !savedUser.id_num) {
            throw new Error("Invalid saved user");
          }
          setUser(savedUser);
        } catch (_error) {
          localStorage.removeItem("city_health_user");
          localStorage.removeItem("city_health_token");
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
      if (token !== synchronizedToken) {
        synchronizedToken = token;
        setLogoutError("");
        heartbeat.pulse();
      }
    }

    function handleStorageChange(event) {
      if (event.storageArea && event.storageArea !== localStorage) return;
      if (event.key === null || event.key === "city_health_user" || event.key === "city_health_token") {
        synchronizeSession();
      }
    }

    // Other tabs share the token used by request(), so their displayed user must
    // follow it too. API authentication failures notify this tab separately.
    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, synchronizeSession);
    synchronizeSession();
    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, synchronizeSession);
      heartbeat.stop();
    };
  }, []);

  const login = async (id_num, password) => {
    try {
      const response = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ id_num, password }),
      });

      if (response.error) {
        if (response.error.includes("Cannot reach the API")) {
          return { success: false, message: "Cannot connect to server. Please ensure backend is running on port 4000." };
        }
        return { success: false, message: response.error };
      }

      if (response.success) {
        localStorage.setItem("city_health_token", response.token);
        localStorage.setItem("city_health_user", JSON.stringify(response.user));
        setUser(response.user);
        window.dispatchEvent(new Event(AUTH_SESSION_CHANGED_EVENT));
        
        if (response.user.role === "superadmin") {
          router.push("/");
        } else {
          if (response.user.id_num === "admin1") router.push("/admin1");
          else if (response.user.id_num === "admin2") router.push("/admin2");
          else if (response.user.id_num === "admin3") router.push("/admin3");
          // Every Front Desk account (by role and doctor assignment), not only the one named "frontdesk".
          else if (canRegisterPatients(response.user)) router.push("/fill-up_form");
          else router.push("/");
        }
        return { success: true };
      }
      return { success: false, message: response.message || "Login failed" };
    } catch (error) {
      return { success: false, message: error.message };
    }
  };

  const logout = async () => {
    const token = localStorage.getItem("city_health_token");
    setLogoutError("");
    if (token) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await request("/auth/logout", {
          method: "POST", body: "{}", authToken: token, signal: controller.signal
        });
      } catch (_error) {
        response = { error: "Logout request failed" };
      } finally {
        window.clearTimeout(timeout);
      }
      // A delayed logout cannot remove a newer login in this or another tab.
      const currentToken = localStorage.getItem("city_health_token");
      if (currentToken && currentToken !== token) return { success: false };
      if ((!response.success || response.error) && currentToken === token) {
        const message = "Logout could not be confirmed by the server. Check your connection and try again.";
        setLogoutError(message);
        return { success: false, message };
      }
    }
    localStorage.removeItem("city_health_token");
    localStorage.removeItem("city_health_user");
    window.dispatchEvent(new Event(AUTH_SESSION_CHANGED_EVENT));
    setUser(null);
    router.push("/login");
    return { success: true };
  };

  const value = { user, login, logout, loading, logoutError };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) {
    // This is the fallback if the provider is missing
    return {
      user: null,
      login: async () => ({ success: false, message: "Authentication provider is missing. Please restart the dev server." }),
      logout: () => {},
      loading: false
    };
  }
  return context;
}
