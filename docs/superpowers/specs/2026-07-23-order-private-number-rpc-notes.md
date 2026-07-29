# orderPrivateNumber Dedicated RPC Notes

## Confirmed Java boundary

- `TpClient.orderPrivateNumber(DTOrderPrivateNumberCmd)` calls `TpClientForJNI.nativeRestCall`.
- `DTRESTCALL_TYPE_ORDER_PRIVATE_NUMBER` is `2050`.
- The command inherits `commandCookie` and `commandTag` from `DTRestCallBase`.
- Normal first purchase does not set either field, so both values remain zero.

## Confirmed native boundary

- JNI mapper: `dingtone::OrderPrivateNumber(JNIEnv *, jobject, tagDTOrderPrivateNumberCmd &)`.
- Query encoder: `EncodeWebOrderPrivateNumberParams(unsigned int, Jeesu::OrderPrivateNumberParamCmd const &)`.
- RPC entry: `Jeesu::CRpcClientInst::OrderPrivateNumber(unsigned int, unsigned int, Jeesu::OrderPrivateNumberParamCmd &)`.
- Response callback: `Jeesu::CRpcClientInst::OnClientOrderPrivateNumberResponse(...)`.
- The RPC entry calls `RtcClient::ProxyRestCall` with `/pstn/share/orderPrivateNumber`.

The dedicated call therefore uses the existing `0107` ProxyRest transport. Its distinguishing request metadata is the 64-bit ProxyRest context, not a different TCP frame family.

## ProxyRest context

`CRpcClientInst::OrderPrivateNumber` constructs the context as:

```text
context = commandTag | (commandCookie << 32)
```

`ProxyRestCall` serializes the eight-byte value in network byte order. In a request body the first eight bytes are the route and the next eight bytes are this context. Therefore:

```text
commandCookie=0, commandTag=0 -> 00 00 00 00 00 00 00 00
```

The captured CommonRest template instead contains `00 00 00 00 00 01 01 01`, which represents CommonRest `commandTag=1` callback metadata and must not be reused unchanged for purchase. CommonRest serializes its context as `commandCookie << 32 | commandTag << 16 | 0x0101`; for example, native `requestPrivateNumber` tag `607` is `00 00 00 00 02 5f 01 01`.

## First-purchase query

The native normal branch formats fields in this order:

```text
token
deviceId
userId
countryCode
areaCode
phoneNumber
type
payFlag
payYears
coupon
specialNumber
callplanId
providerId
packageServiceId
simCC
simu
extraChargeMonthsCount
apiVersion
buyCredit
```

`productId` is not serialized. `DTOrderPrivateNumberCmd.apiVersion` defaults to `4`, and the credit-purchase Java path does not override it.

## Response payload

`DecodeWebOrderPrivateNumberParams` reads the JSON response fields:

```text
phoneNumber
payFlag
payYears
gainTime
payTime
provision
payType
providerId
packageServiceId
expireTime
```

The outer response still travels through the existing ProxyRest JSON frame parser. Exact server error-code mappings for sold-out, KYC, and insufficient-credit cases were not present in the static client and must not be invented. Until live read-only evidence or an observed failed response supplies those mappings, the backend should preserve the server `Result`, `ErrCode`, and `Reason` values and use generic sanitized failure handling.
