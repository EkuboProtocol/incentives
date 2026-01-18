export const INCENTIVES_ABI = [
  {
    type: "function",
    name: "claim",
    inputs: [
      {
        name: "key",
        type: "tuple",
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "c",
        type: "tuple",
        internalType: "struct ClaimKey",
        components: [
          {
            name: "index",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "account",
            type: "address",
            internalType: "address",
          },
          {
            name: "amount",
            type: "uint128",
            internalType: "uint128",
          },
        ],
      },
      {
        name: "proof",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "fund",
    inputs: [
      {
        name: "key",
        type: "tuple",
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "minimum",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [
      {
        name: "fundedAmount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "multicall",
    inputs: [
      {
        name: "data",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "refund",
    inputs: [
      {
        name: "key",
        type: "tuple",
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "refundAmount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Funded",
    inputs: [
      {
        name: "key",
        type: "tuple",
        indexed: false,
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "amountNext",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      {
        name: "key",
        type: "tuple",
        indexed: false,
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "refundAmount",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AlreadyClaimed",
    inputs: [],
  },
  {
    type: "error",
    name: "DropOwnerOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "InsufficientFunds",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidProof",
    inputs: [],
  },
] as const;
