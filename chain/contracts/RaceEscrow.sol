// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title RaceEscrow
/// @notice Local two-driver race escrow with typed entry authorization.
contract RaceEscrow is EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    enum Status {
        None,
        Created,
        Joined,
        Locked,
        Started,
        Finished,
        Settled,
        Canceled
    }

    struct RaceView {
        Status status;
        bytes32 localRoundId;
        address challenger;
        address opponent;
        bool challengerJoined;
        bool opponentJoined;
        uint256 stakeAmount;
        uint256 feeAmount;
        uint256 feesCollected;
        uint8 winnerSlot;
        bytes32 proofHash;
        uint256 createdAt;
        uint256 lockedAt;
        uint256 startedAt;
        uint256 finishedAt;
    }

    struct Race {
        Status status;
        bytes32 localRoundId;
        address challenger;
        address opponent;
        bool challengerJoined;
        bool opponentJoined;
        uint256 stakeAmount;
        uint256 feeAmount;
        uint256 feesCollected;
        uint8 winnerSlot;
        bytes32 proofHash;
        uint256 createdAt;
        uint256 lockedAt;
        uint256 startedAt;
        uint256 finishedAt;
    }

    bytes32 public constant RACE_ENTRY_TYPEHASH = keccak256(
        "RaceEntry(uint256 raceId,address driver,uint8 slot,uint256 stakeAmount,uint256 feeAmount,uint256 nonce,uint256 deadline)"
    );

    IERC20 public immutable token;
    IERC20Permit public immutable permitToken;
    address public treasury;
    address public operator;
    address public facilitator;
    uint256 public nextRaceId;
    uint256 public totalFeesCollected;

    mapping(uint256 => Race) private races;
    mapping(address => uint256) public nonces;

    event RaceOpened(uint256 indexed raceId, bytes32 indexed localRoundId, uint256 stakeAmount, uint256 feeAmount);
    event RaceJoined(uint256 indexed raceId, address indexed driver, uint8 indexed slot, uint256 stakeAmount, uint256 feeAmount);
    event RaceLocked(uint256 indexed raceId);
    event RaceStarted(uint256 indexed raceId);
    event RaceFinished(uint256 indexed raceId, uint8 winnerSlot, bytes32 proofHash);
    event RaceSettled(uint256 indexed raceId, address indexed winner, uint256 payout);
    event RaceCanceled(uint256 indexed raceId, string reason);
    event FacilitatorChanged(address indexed facilitator);
    event TreasuryChanged(address indexed treasury);

    error NotFacilitator();
    error NotOperator();
    error BadState();
    error BadSlot();
    error BadDriver();
    error BadAmount();
    error Expired();
    error InvalidSignature();
    error AlreadyJoined();
    error TransferFailed();

    modifier onlyFacilitator() {
        if (msg.sender != facilitator) revert NotFacilitator();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address token_, address treasury_, address operator_, address facilitator_)
        EIP712("RoverRace", "1")
    {
        require(token_ != address(0), "token required");
        require(treasury_ != address(0), "treasury required");
        require(operator_ != address(0), "operator required");
        require(facilitator_ != address(0), "facilitator required");
        token = IERC20(token_);
        permitToken = IERC20Permit(token_);
        treasury = treasury_;
        operator = operator_;
        facilitator = facilitator_;
    }

    function openRace(bytes32 localRoundId, uint256 stakeAmount, uint256 feeAmount)
        external
        onlyFacilitator
        returns (uint256 raceId)
    {
        if (stakeAmount == 0) revert BadAmount();
        raceId = nextRaceId++;
        Race storage race = races[raceId];
        race.status = Status.Created;
        race.localRoundId = localRoundId;
        race.stakeAmount = stakeAmount;
        race.feeAmount = feeAmount;
        race.createdAt = block.timestamp;
        emit RaceOpened(raceId, localRoundId, stakeAmount, feeAmount);
    }

    function joinWithAuthorization(
        uint256 raceId,
        address driver,
        uint8 slot,
        uint256 stakeAmount,
        uint256 feeAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant onlyFacilitator {
        _joinWithAuthorization(raceId, driver, slot, stakeAmount, feeAmount, deadline, v, r, s);
    }

    function joinWithAuthorizationAndPermit(
        uint256 raceId,
        address driver,
        uint8 slot,
        uint256 stakeAmount,
        uint256 feeAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 permitDeadline,
        uint8 permitV,
        bytes32 permitR,
        bytes32 permitS
    ) external nonReentrant onlyFacilitator {
        permitToken.permit(driver, address(this), stakeAmount + feeAmount, permitDeadline, permitV, permitR, permitS);
        _joinWithAuthorization(raceId, driver, slot, stakeAmount, feeAmount, deadline, v, r, s);
    }

    function lockRace(uint256 raceId) external onlyFacilitator {
        Race storage race = races[raceId];
        if (race.status != Status.Joined || !race.challengerJoined || !race.opponentJoined) revert BadState();
        race.status = Status.Locked;
        race.lockedAt = block.timestamp;
        emit RaceLocked(raceId);
    }

    function startRace(uint256 raceId) external onlyFacilitator {
        Race storage race = races[raceId];
        if (race.status != Status.Locked) revert BadState();
        race.status = Status.Started;
        race.startedAt = block.timestamp;
        emit RaceStarted(raceId);
    }

    function finishRace(uint256 raceId, uint8 winnerSlot, bytes32 proofHash) external onlyFacilitator {
        Race storage race = races[raceId];
        if (race.status != Status.Started) revert BadState();
        if (winnerSlot > 1) revert BadSlot();
        race.status = Status.Finished;
        race.winnerSlot = winnerSlot;
        race.proofHash = proofHash;
        race.finishedAt = block.timestamp;
        emit RaceFinished(raceId, winnerSlot, proofHash);
    }

    function settleRace(uint256 raceId) external nonReentrant onlyFacilitator {
        Race storage race = races[raceId];
        if (race.status != Status.Finished) revert BadState();
        address winner = race.winnerSlot == 0 ? race.challenger : race.opponent;
        uint256 payout = race.stakeAmount * 2;
        race.status = Status.Settled;
        if (!token.transfer(winner, payout)) revert TransferFailed();
        emit RaceSettled(raceId, winner, payout);
    }

    function cancelRace(uint256 raceId, string calldata reason) external nonReentrant onlyFacilitator {
        Race storage race = races[raceId];
        if (
            race.status == Status.None ||
            race.status == Status.Finished ||
            race.status == Status.Settled ||
            race.status == Status.Canceled
        ) revert BadState();
        race.status = Status.Canceled;
        if (race.challengerJoined && race.stakeAmount > 0) {
            if (!token.transfer(race.challenger, race.stakeAmount)) revert TransferFailed();
        }
        if (race.opponentJoined && race.stakeAmount > 0) {
            if (!token.transfer(race.opponent, race.stakeAmount)) revert TransferFailed();
        }
        emit RaceCanceled(raceId, reason);
    }

    function setFacilitator(address facilitator_) external onlyOperator {
        require(facilitator_ != address(0), "facilitator required");
        facilitator = facilitator_;
        emit FacilitatorChanged(facilitator_);
    }

    function setTreasury(address treasury_) external onlyOperator {
        require(treasury_ != address(0), "treasury required");
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function getRace(uint256 raceId) external view returns (RaceView memory) {
        Race storage race = races[raceId];
        return RaceView({
            status: race.status,
            localRoundId: race.localRoundId,
            challenger: race.challenger,
            opponent: race.opponent,
            challengerJoined: race.challengerJoined,
            opponentJoined: race.opponentJoined,
            stakeAmount: race.stakeAmount,
            feeAmount: race.feeAmount,
            feesCollected: race.feesCollected,
            winnerSlot: race.winnerSlot,
            proofHash: race.proofHash,
            createdAt: race.createdAt,
            lockedAt: race.lockedAt,
            startedAt: race.startedAt,
            finishedAt: race.finishedAt
        });
    }

    function hashRaceEntry(
        uint256 raceId,
        address driver,
        uint8 slot,
        uint256 stakeAmount,
        uint256 feeAmount,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            RACE_ENTRY_TYPEHASH,
            raceId,
            driver,
            slot,
            stakeAmount,
            feeAmount,
            nonce,
            deadline
        )));
    }

    function _joinWithAuthorization(
        uint256 raceId,
        address driver,
        uint8 slot,
        uint256 stakeAmount,
        uint256 feeAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        if (block.timestamp > deadline) revert Expired();
        Race storage race = races[raceId];
        if (race.status != Status.Created && race.status != Status.Joined) revert BadState();
        if (slot > 1) revert BadSlot();
        if (stakeAmount != race.stakeAmount || feeAmount != race.feeAmount) revert BadAmount();

        uint256 nonce = nonces[driver];
        bytes32 digest = hashRaceEntry(raceId, driver, slot, stakeAmount, feeAmount, nonce, deadline);
        address signer = digest.recover(v, r, s);
        if (signer != driver) revert InvalidSignature();
        nonces[driver] = nonce + 1;

        if (slot == 0) {
            if (race.challengerJoined) revert AlreadyJoined();
            race.challenger = driver;
            race.challengerJoined = true;
        } else {
            if (race.opponentJoined) revert AlreadyJoined();
            if (driver == race.challenger) revert BadDriver();
            race.opponent = driver;
            race.opponentJoined = true;
        }

        if (!token.transferFrom(driver, address(this), stakeAmount)) revert TransferFailed();
        if (feeAmount > 0) {
            if (!token.transferFrom(driver, treasury, feeAmount)) revert TransferFailed();
            race.feesCollected += feeAmount;
            totalFeesCollected += feeAmount;
        }
        if (race.challengerJoined && race.opponentJoined) {
            race.status = Status.Joined;
        }

        emit RaceJoined(raceId, driver, slot, stakeAmount, feeAmount);
    }
}
