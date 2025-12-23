import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUp, faCheck, faXmark, faExclamationTriangle } from '@fortawesome/free-solid-svg-icons';
import { useUpdate } from '../contexts';
import styles from './UpdateNotification.module.css';
import shared from '../styles/shared.module.css';

/**
 * Update notification banner that appears when updates are available.
 * Shows different states: available, downloading, downloaded, error.
 */
const UpdateNotification: React.FC = () => {
  const { status, downloadUpdate, installUpdate, dismissUpdate, isDismissed } = useUpdate();

  // Don't show if dismissed or idle/checking
  if (isDismissed || status.status === 'idle' || status.status === 'checking') {
    return null;
  }

  // Update available - show download prompt
  if (status.status === 'available') {
    return (
      <div className={`${styles.banner} ${styles.bannerAvailable}`}>
        <div className={styles.bannerContent}>
          <FontAwesomeIcon icon={faArrowUp} className={styles.icon} />
          <span className={styles.message}>
            Version {status.availableVersion} is available
          </span>
        </div>
        <div className={styles.bannerActions}>
          <button className={styles.btnBanner} onClick={downloadUpdate}>
            Download
          </button>
          <button
            className={styles.btnDismiss}
            onClick={dismissUpdate}
            title="Remind me later"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </div>
    );
  }

  // Downloading - show progress
  if (status.status === 'downloading') {
    const progress = status.downloadProgress ?? 0;
    return (
      <div className={`${styles.banner} ${styles.bannerDownloading}`}>
        <div className={styles.bannerContent}>
          <div className={shared.spinner} />
          <span className={styles.message}>
            Downloading update... {progress}%
          </span>
        </div>
        <div className={styles.progressBar}>
          <div
            className={styles.progressFill}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    );
  }

  // Downloaded - prompt to install
  if (status.status === 'downloaded') {
    return (
      <div className={`${styles.banner} ${styles.bannerReady}`}>
        <div className={styles.bannerContent}>
          <FontAwesomeIcon icon={faCheck} className={styles.iconSuccess} />
          <span className={styles.message}>
            Update ready to install
          </span>
        </div>
        <div className={styles.bannerActions}>
          <button className={styles.btnBannerPrimary} onClick={installUpdate}>
            Restart &amp; Install
          </button>
          <button
            className={styles.btnDismiss}
            onClick={dismissUpdate}
            title="Install later"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </div>
    );
  }

  // Error state
  if (status.status === 'error') {
    return (
      <div className={`${styles.banner} ${styles.bannerError}`}>
        <div className={styles.bannerContent}>
          <FontAwesomeIcon icon={faExclamationTriangle} className={styles.iconError} />
          <span className={styles.message}>
            Update failed: {status.error}
          </span>
        </div>
        <div className={styles.bannerActions}>
          <button
            className={styles.btnDismiss}
            onClick={dismissUpdate}
            title="Dismiss"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </div>
    );
  }

  return null;
};

export default UpdateNotification;
