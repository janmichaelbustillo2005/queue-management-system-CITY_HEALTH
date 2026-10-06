import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";
import DoctorAdmin from "../components/DoctorAdmin";

export default function Admin2() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || (user.role !== "superadmin" && user.id_num !== "admin2"))) {
      router.push("/login");
    }
  }, [user, loading, router]);

  const isLoading = loading || !user || (user.role !== "superadmin" && user.id_num !== "admin2");

  return isLoading ? <div className="flex items-center justify-center min-h-screen">Loading...</div> : <DoctorAdmin doctorId={2} doctorName="Doctor 2" />;
}
