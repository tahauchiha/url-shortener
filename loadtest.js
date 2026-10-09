import http from "k6/http";
import { check } from "k6";

export const options = {
  stages: [
    { duration: "10s", target: 50 },
    { duration: "30s", target: 50 },
  ],
};

export default function () {
  const res = http.get(`${__ENV.BASE}/${__ENV.CODE}`, { redirects: 0 });
  check(res, { "is 302": (r) => r.status === 302 });
}