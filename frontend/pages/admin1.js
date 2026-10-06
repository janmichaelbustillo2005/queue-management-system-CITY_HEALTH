import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../context/AuthContext";
import DoctorAdmin from "../components/DoctorAdmin";

export default function Admin1() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || (user.role !== "superadmin" && user.id_num !== "admin1"))) {
      router.push("/login");
    }
  }, [user, loading, router]);

  const isLoading = loading || !user || (user.role !== "superadmin" && user.id_num !== "admin1");

  return isLoading ? <div className="flex items-center justify-center min-h-screen">Loading...</div> : <DoctorAdmin doctorId={1} doctorName="Doctor 1" />;
}
