import { useEffect } from "react";
import { useRouter } from "next/router";

export default function DisplayRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/queue-display");
  }, [router]);

  return null;
}
