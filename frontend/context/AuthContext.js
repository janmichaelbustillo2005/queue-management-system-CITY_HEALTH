import React, { createContext, useContext, useState, useEffect } from "react";
import { useRouter } from "next/router";
import { request } from "../lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    // Wait for hydration to access localStorage
    const storedUser = localStorage.getItem("city_health_user");
    const token = localStorage.getItem("city_health_token");
    if (storedUser && token) {
      try {
        setUser(JSON.parse(storedUser));
      } catch (e) {
        localStorage.removeItem("city_health_user");
        localStorage.removeItem("city_health_token");
      }
    }
    setLoading(false);
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
        
        if (response.user.role === "superadmin") {
          router.push("/");
        } else {
          if (response.user.id_num === "admin1") router.push("/admin1");
          else if (response.user.id_num === "admin2") router.push("/admin2");
          else if (response.user.id_num === "admin3") router.push("/admin3");
          else if (response.user.id_num === "frontdesk") router.push("/fill-up_form");
          else router.push("/");
        }
        return { success: true };
      }
      return { success: false, message: response.message || "Login failed" };
    } catch (error) {
      return { success: false, message: error.message };
    }
  };

  const logout = () => {
    localStorage.removeItem("city_health_token");
    localStorage.removeItem("city_health_user");
    setUser(null);
    router.push("/login");
  };

  const value = { user, login, logout, loading };

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
