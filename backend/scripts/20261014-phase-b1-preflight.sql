-- Phase B.1 catalog-only supplement. NOT a migration. Prepared, not executed.
-- Use only on the explicitly identified, confirmed NON-PRODUCTION project.
-- Run alongside 20261013-phase-a1-preflight.sql for Phase A canonical checks
-- and transitive role membership. This script reads no application rows and
-- calls no application RPC. Review unexpected catalog literals before export.
BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database_name, current_user AS executing_role,
 current_setting('server_version') AS server_version,
 current_setting('transaction_read_only') AS transaction_read_only;

-- Relation presence, owner, RLS, and FORCE RLS. Absence is visible.
WITH expected(name) AS (VALUES ('patients'),('users'),('counters'),('staff_auth_sessions'),('staff_auth_activity'))
SELECT e.name, c.oid IS NOT NULL AS exists, c.relkind,
 pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity
FROM expected e LEFT JOIN pg_namespace n ON n.nspname='public'
LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=e.name ORDER BY e.name;

-- Columns: metadata only. Password/revision defaults deliberately suppressed.
SELECT c.relname AS table_name,a.attname AS column_name,
 format_type(a.atttypid,a.atttypmod) AS column_type,a.attnotnull,
 CASE WHEN a.attname IN ('password','auth_revision') THEN '[private default suppressed]'
 ELSE pg_get_expr(d.adbin,d.adrelid) END AS column_default,
 a.attidentity,a.attgenerated
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
WHERE n.nspname='public' AND c.relname IN ('patients','users','counters','staff_auth_sessions','staff_auth_activity')
ORDER BY c.relname,a.attnum;

-- Known compatibility gates. Presence alone does not prove type/nullability.
WITH expected(table_name,column_name) AS (VALUES
 ('patients','consultation_started_at'),('patients','completed_at'),('patients','first_name'),('patients','last_name'),
 ('users','auth_revision'),('users','created_at'),('staff_auth_activity','id'),('staff_auth_activity','user_id_num'),
 ('staff_auth_activity','event'),('staff_auth_activity','occurred_at'))
SELECT e.*,a.attnum IS NOT NULL AS exists,format_type(a.atttypid,a.atttypmod) AS actual_type,a.attnotnull
FROM expected e LEFT JOIN pg_namespace n ON n.nspname='public'
LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name
LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=e.column_name AND a.attnum>0 AND NOT a.attisdropped
ORDER BY e.table_name,e.column_name;

SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_type t
JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
WHERE n.nspname='public' AND t.typname IN ('queue_status','user_role') ORDER BY t.typname,e.enumsortorder;
SELECT c.relname AS table_name,k.conname,k.contype,k.convalidated,
 pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k
JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('patients','users','counters','staff_auth_sessions','staff_auth_activity')
ORDER BY c.relname,k.conname;
SELECT c.relname AS table_name,i.relname AS index_name,x.indisvalid,x.indisready,
 pg_get_indexdef(i.oid) AS definition FROM pg_index x
JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class i ON i.oid=x.indexrelid
WHERE n.nspname='public' AND c.relname IN ('patients','users','counters','staff_auth_sessions','staff_auth_activity')
ORDER BY c.relname,i.relname;
SELECT c.relname AS table_name,t.tgname,t.tgenabled,t.tgisinternal,
 pg_get_triggerdef(t.oid,true) AS definition,pg_get_userbyid(p.proowner) AS function_owner
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public'
AND c.relname IN ('patients','users','counters','staff_auth_sessions','staff_auth_activity') ORDER BY c.relname,t.tgname;

-- All overloads and exact named parameters. Function bodies are not exported.
SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS identity_arguments,p.proargnames,
 pg_get_function_result(p.oid) AS result_type,p.prokind,p.prosecdef,p.proconfig,p.provolatile,
 pg_get_userbyid(p.proowner) AS owner,
 CASE WHEN p.prokind IN ('f','p') THEN md5(pg_get_functiondef(p.oid)) END AS definition_fingerprint,
 CASE WHEN p.proname='revoke_staff_auth_session'
 THEN strpos(p.prosrc,'staff_auth_activity')>0 AND strpos(p.prosrc,'''logout''')>0 END AS has_phase_b_logout_body
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
AND p.proname IN ('start_patient_consultation','complete_patient_consultation','create_staff_auth_session',
 'validate_staff_auth_session','heartbeat_staff_auth_session','revoke_staff_auth_session','revoke_staff_user_sessions',
 'revoke_changed_staff_sessions','get_staff_doctor_presence','get_central_records','record_staff_login')
ORDER BY p.proname,identity_arguments;

WITH expected(signature) AS (VALUES
 ('public.start_patient_consultation(bigint,text,text,timestamp with time zone)'),
 ('public.complete_patient_consultation(bigint,text,text,timestamp with time zone,text)'),
 ('public.create_staff_auth_session(uuid,text,text,text,uuid)'),
 ('public.validate_staff_auth_session(uuid,text,text,text)'),
 ('public.heartbeat_staff_auth_session(uuid,text,text,text)'),
 ('public.revoke_staff_auth_session(uuid,text)'),('public.revoke_staff_user_sessions(text)'),
 ('public.get_staff_doctor_presence()'),('public.get_central_records(text,jsonb,integer,integer)'),
 ('public.record_staff_login()'))
SELECT signature,to_regprocedure(signature) IS NOT NULL AS exists FROM expected ORDER BY signature;

-- Effective RPC and table/column privileges, including inherited roles.
WITH roles AS (SELECT oid,rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))
SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS identity_arguments,r.rolname,
 has_function_privilege(r.oid,p.oid,'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN roles r
WHERE n.nspname='public' AND p.proname IN ('start_patient_consultation','complete_patient_consultation',
 'create_staff_auth_session','validate_staff_auth_session','heartbeat_staff_auth_session','revoke_staff_auth_session',
 'revoke_staff_user_sessions','get_staff_doctor_presence','get_central_records','record_staff_login')
ORDER BY p.proname,identity_arguments,r.rolname;
WITH roles AS (SELECT oid,rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))
SELECT c.relname,r.rolname,has_table_privilege(r.oid,c.oid,'SELECT') AS can_select,
 has_table_privilege(r.oid,c.oid,'INSERT') AS can_insert,has_table_privilege(r.oid,c.oid,'UPDATE') AS can_update,
 has_table_privilege(r.oid,c.oid,'DELETE') AS can_delete
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN roles r
WHERE n.nspname='public' AND c.relname IN ('patients','users','counters','staff_auth_sessions','staff_auth_activity')
ORDER BY c.relname,r.rolname;
WITH roles AS (SELECT oid,rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))
SELECT c.relname,a.attname,r.rolname,has_column_privilege(r.oid,c.oid,a.attnum,'SELECT') AS can_select,
 has_column_privilege(r.oid,c.oid,a.attnum,'INSERT') AS can_insert,
 has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE') AS can_update
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
CROSS JOIN roles r WHERE n.nspname='public' AND c.relname IN ('patients','users','staff_auth_sessions','staff_auth_activity')
AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum,r.rolname;
SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
WHERE schemaname='public' AND tablename IN ('patients','users','counters','staff_auth_sessions','staff_auth_activity')
ORDER BY tablename,policyname;
-- Direct ACL grantor chains, including PUBLIC and sequence ownership.
SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,
 CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
 pg_get_userbyid(x.grantor) AS grantor,x.privilege_type,x.is_grantable
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) x
WHERE n.nspname='public' AND c.relname IN ('patients','users','counters','staff_auth_sessions','staff_auth_activity','staff_auth_activity_id_seq')
ORDER BY c.relname,grantee,x.privilege_type;
-- Actual identity-sequence dependency rather than assuming its name.
SELECT tab.relname AS table_name,col.attname AS column_name,seq.relname AS sequence_name,
 dep.deptype,pg_get_userbyid(seq.relowner) AS sequence_owner
FROM pg_depend dep JOIN pg_class seq ON seq.oid=dep.objid AND seq.relkind='S'
JOIN pg_class tab ON tab.oid=dep.refobjid JOIN pg_namespace n ON n.oid=tab.relnamespace
JOIN pg_attribute col ON col.attrelid=tab.oid AND col.attnum=dep.refobjsubid
WHERE dep.classid='pg_catalog.pg_class'::regclass AND dep.refclassid='pg_catalog.pg_class'::regclass
AND dep.deptype IN ('a','i') AND n.nspname='public' AND tab.relname='staff_auth_activity';
-- Attributes of all reviewed function/table owners, including Phase 2 and B.
WITH owners(oid) AS (
 SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('patients','users','counters','staff_auth_sessions','staff_auth_activity')
 UNION SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('start_patient_consultation','complete_patient_consultation',
 'create_staff_auth_session','validate_staff_auth_session','heartbeat_staff_auth_session','revoke_staff_auth_session',
 'revoke_staff_user_sessions','revoke_changed_staff_sessions','get_staff_doctor_presence','get_central_records','record_staff_login')
)
SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolinherit,r.rolcanlogin FROM pg_roles r
WHERE r.oid IN (SELECT oid FROM owners) OR r.rolname IN ('anon','authenticated','service_role') ORDER BY r.rolname;
-- Ledger existence only; existence is not evidence that manual migrations ran.
SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE (n.nspname='supabase_migrations' AND c.relname='schema_migrations') ORDER BY n.nspname,c.relname;
COMMIT;
