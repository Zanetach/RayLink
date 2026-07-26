# RayLink Control Plane

RayLink manages authenticated users, user-owned service entitlements, and the configuration published to a sing-box runtime.

## Language

**User**:
A person allowed to sign in to the user center and own exactly one User Entitlement.
_Avoid_: Client, subscriber, token

**User Entitlement**:
Traffic allowance, device limit, node scope, and supported client formats owned by exactly one User. It cannot be assigned to or reused by another User.
_Avoid_: Plan, subscription, package

**Runtime Credential**:
A private protocol credential owned by one User and compiled into sing-box configuration.
_Avoid_: Shared key, subscription token

**Host**:
A machine capable of running a sing-box Runtime.
_Avoid_: Node when referring to the machine itself

**Runtime**:
The sing-box process and active configuration on a Host.
_Avoid_: Core, daemon

**Deployment**:
An immutable attempt to compile, validate, and publish a control-plane snapshot to a Runtime.
_Avoid_: Save, sync

**User Center**:
The authenticated surface where a User sees their User Entitlement and downloads client configuration.
_Avoid_: Subscription page, token page
