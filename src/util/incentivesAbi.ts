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
        internalType: "struct Claim",
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
    name: "claimed",
    inputs: [
      {
        name: "id",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "Bitmap",
      },
    ],
    stateMutability: "view",
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
    name: "getRemaining",
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
        name: "",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isAvailable",
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
        name: "index",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "amount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isClaimed",
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
        name: "index",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
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
